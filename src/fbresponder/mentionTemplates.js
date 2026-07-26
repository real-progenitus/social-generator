// Fixed, non-AI-generated replies for the "mention" event type (someone
// tags/mentions the Page in their own post — distinct from a comment on our
// own content). Per product decision, mentions get a static localized
// template, not a Claude call: it's a one-shot public reply pointing people
// back to the app, not a conversation that benefits from generation.
//
// Draft copy — the Portuguese (Brazilian) variant in particular has not had
// native-speaker review (same caution as generateReply.js's BR dialect
// block); treat as a starting point, not final marketing copy.
const IFOUND_LINK = "https://ifound.tech";
const IFOUND_LINK_PT = "https://www.ifound.tech/pt";

const TEMPLATES = {
  "Portuguese|european": `Obrigado pela menção! 🙏 Perdeu ou encontrou algo? Publique na ifound para podermos ajudar: ${IFOUND_LINK_PT}`,
  "Portuguese|brazilian": `Obrigado pela menção! 🙏 Perdeu ou achou algo? Poste no ifound para ajudarmos a encontrar: ${IFOUND_LINK_PT}`,
  Spanish: `¡Gracias por la mención! 🙏 ¿Perdiste o encontraste algo? Publícalo en ifound para ayudar a conectarlo: ${IFOUND_LINK}`,
  French: `Merci de nous avoir mentionnés ! 🙏 Vous avez perdu ou trouvé quelque chose ? Publiez-le sur ifound : ${IFOUND_LINK}`,
  Italian: `Grazie per averci menzionato! 🙏 Hai perso o trovato qualcosa? Pubblicalo su ifound: ${IFOUND_LINK}`,
  English: `Thanks for the mention! 🙏 Lost or found something? Post it on ifound so we can help connect it: ${IFOUND_LINK}`,
};

export function getMentionReplyText(page) {
  const templateKey = page.language === "Portuguese" ? `Portuguese|${page.ptDialect}` : page.language;
  return TEMPLATES[templateKey] ?? TEMPLATES.English;
}
