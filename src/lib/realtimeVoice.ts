import { AUXILIARY_MODELS } from "@/lib/modelPolicy";

export const REALTIME_MODEL = AUXILIARY_MODELS.realtimeVoice;
export const REALTIME_VOICE = "marin" as const;
export const VOICE_TOOL_NAME = "answer_from_company_file" as const;

export function realtimeSessionConfig(ticker: string) {
  return {
    type: "realtime",
    model: REALTIME_MODEL,
    output_modalities: ["audio"],
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        voice: REALTIME_VOICE,
      },
    },
    instructions:
      `You are the spoken interface to the closed ${ticker} AMM company file. ` +
      "You are not a general assistant, investment adviser, or independent research model. " +
      `For EVERY member question about ${ticker}, its thesis, numbers, filings, news, price action, risks, dates, latest developments, or implications, call ${VOICE_TOOL_NAME}. ` +
      `The tool is the only source of truth. Never answer such a question from memory, the conversation, or model knowledge. ` +
      "When the tool returns spokenAnswer, speak it faithfully without adding, weakening, updating, or agreeing with any claim. " +
      "Do not read URLs aloud. The visual interface shows the dated citations. " +
      "For a greeting, microphone check, request to repeat, or call-control question only, respond briefly without the tool. " +
      "If asked about another company or an unrelated topic, say: 'That is outside this company’s AMM file. Open that company in AMM Desk to research it.' " +
      "If asked what to buy, sell, hold, how much to invest, or for personalised advice, say: 'AMM provides sourced research, not personalised investment instructions. I can explain the thesis, evidence, risks, and what would change the read.' " +
      "Never praise the question, mirror the member's opinion, say they are right, or present unsupported current events. " +
      "Keep spoken delivery direct, calm, plain-English, and normally under ninety seconds.",
    tools: [
      {
        type: "function",
        name: VOICE_TOOL_NAME,
        description:
          `Answer one question using only ${ticker}'s immutable, dated AMM company-file context. ` +
          "Required for every substantive company or market question.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The member's complete question, preserving any requested date or comparison.",
            },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: "auto",
  };
}
