const GRAPH = "https://graph.facebook.com/v21.0";

async function graph(method, endpoint, params, accessToken) {
  const url = new URL(`${GRAPH}/${endpoint}`);
  const search = new URLSearchParams({
    ...params,
    access_token: accessToken,
  });
  let res;
  if (method === "GET") {
    url.search = search.toString();
    res = await fetch(url);
  } else {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: search,
    });
  }
  const json = await res.json();
  if (json.error) throw new Error(`Graph API error: ${JSON.stringify(json.error)}`);
  return json;
}

export async function replyToComment(commentId, message, accessToken) {
  return graph("POST", `${commentId}/comments`, { message }, accessToken);
}

export async function sendMessengerMessage(recipientId, text, accessToken) {
  return graph(
    "POST",
    "me/messages",
    {
      recipient: JSON.stringify({ id: recipientId }),
      message: JSON.stringify({ text }),
      messaging_type: "RESPONSE",
    },
    accessToken,
  );
}

// Messenger's own "is typing…" indicator - shows for a few seconds (or
// until a message is sent). Used to make auto-sent replies read as a person
// typing rather than a reply appearing out of nowhere.
//
// Purely cosmetic, so it must never throw: Meta rejects sender_actions on
// their own terms (seen live on 2026-07-31 as "(#100) Sender action failed",
// subcode 2018048) and this used to be the first await in routeGeneratedReply's
// try block, so one refused typing bubble aborted the real reply that had
// already been generated and paid for - the person just got silence. Same
// degrade-don't-throw contract as fetchPostContext/fetchUserLocale above.
export async function sendTypingOn(recipientId, accessToken) {
  try {
    return await graph(
      "POST",
      "me/messages",
      {
        recipient: JSON.stringify({ id: recipientId }),
        sender_action: "typing_on",
      },
      accessToken,
    );
  } catch (err) {
    console.error(`[fbresponder/graph] typing indicator failed for ${recipientId}:`, err.message);
    return null;
  }
}

// Grounds a comment reply in what the parent post actually said, rather than
// generating from the bare comment text alone. Also reused for mentions, to
// pull a readable snippet of the mentioning post/comment for Telegram.
export async function fetchPostContext(postId, accessToken) {
  try {
    const { message } = await graph("GET", postId, { fields: "message" }, accessToken);
    return message ?? "";
  } catch (err) {
    console.error(`[fbresponder/graph] failed to fetch post context for ${postId}:`, err.message);
    return "";
  }
}

// Sender's Messenger account locale (e.g. "es_CO"), used as a language hint
// for image-only DMs that carry no text to detect language from. Meta has
// restricted several User Profile API fields (first_name, last_name,
// profile_pic) behind business-verification gates in recent years, and
// whether "locale" still returns real data for arbitrary PSIDs is unverified
// here - so this must degrade to null on any error or empty response, never
// throw, so callers can always fall back to today's default behavior.
export async function fetchUserLocale(psid, accessToken) {
  try {
    const { locale } = await graph("GET", psid, { fields: "locale" }, accessToken);
    return locale || null;
  } catch (err) {
    console.error(`[fbresponder/graph] failed to fetch locale for ${psid}:`, err.message);
    return null;
  }
}

// Downloads a DM image attachment's bytes for the Gemini vision hop (see
// generateReply.js's describeImageViaGemini). These are Meta CDN URLs handed
// to us directly in the webhook payload (attachment.payload.url) - public,
// signed, no page access token needed, unlike the rest of this file.
export async function fetchImageBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { base64: buffer.toString("base64"), mimeType };
}
