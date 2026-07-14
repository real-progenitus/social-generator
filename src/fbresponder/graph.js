import { config } from "../config.js";

const GRAPH = "https://graph.facebook.com/v21.0";

async function graph(method, endpoint, params) {
  const url = new URL(`${GRAPH}/${endpoint}`);
  const search = new URLSearchParams({
    ...params,
    access_token: config.facebookPageAccessToken,
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

export async function replyToComment(commentId, message) {
  return graph("POST", `${commentId}/comments`, { message });
}

export async function sendMessengerMessage(recipientId, text) {
  return graph("POST", "me/messages", {
    recipient: JSON.stringify({ id: recipientId }),
    message: JSON.stringify({ text }),
    messaging_type: "RESPONSE",
  });
}

// Messenger's own "is typing…" indicator - shows for a few seconds (or
// until a message is sent). Used to make auto-sent replies read as a person
// typing rather than a reply appearing out of nowhere.
export async function sendTypingOn(recipientId) {
  return graph("POST", "me/messages", {
    recipient: JSON.stringify({ id: recipientId }),
    sender_action: "typing_on",
  });
}

// Grounds a comment reply in what the parent post actually said, rather than
// generating from the bare comment text alone.
export async function fetchPostContext(postId) {
  try {
    const { message } = await graph("GET", postId, { fields: "message" });
    return message ?? "";
  } catch (err) {
    console.error(`[fbresponder/graph] failed to fetch post context for ${postId}:`, err.message);
    return "";
  }
}
