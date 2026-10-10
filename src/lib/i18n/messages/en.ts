// Participant-facing text: the source every translation must match key for
// key (the `Messages` type). Researcher screens stay English. Translations
// are AI-reviewed, not certified (docs/translations/); the data notice is
// close to a legal text, so change it here first and re-review every language.

import type { InterviewPhase } from '@/types';

export interface Messages {
  link: {
    loading: string;
    unableTitle: string;
    checkLink: string;
    noCode: string;
    invalid: string;
    noSession: string;
    transportUnknown: string;
    loadFailed: string;
  };
  noSession: { title: string; body: string; cause: string };
  language: { label: string; hint: string };
  consent: {
    label: string;
    structureTitle: string;
    background: string;
    backgroundHint: string;
    coreQuestions: (count: number) => string;
    coreHint: string;
    followUps: string;
    followUpsHint: string;
    feedback: string;
    feedbackHint: string;
    estimatedTime: string;
    dataNoticeLabel: string;
    controller: string;
    researcherContact: string;
    unavailableSettings: string;
    unavailableReopen: string;
    back: string;
    accept: string;
    recording: string;
    opening: string;
    returning: string;
    errors: {
      recordFailed: string;
      disclosureChanged: string;
      languageNotOffered: string;
      unavailable: string;
      reopen: string;
    };
    transport: {
      unconfirmed: string;
      notReady: string;
      cloudflareGatewayOpenRouter: string;
      cloudflareGateway: (provider: string) => string;
      vercelGateway: (provider: string) => string;
      directOpenRouter: string;
      direct: (provider: string) => string;
    };
    commitment: {
      fixedOpenRouter: (model: string) => string;
      fixed: (model: string, provider: string) => string;
      mayChange: string;
    };
    /** Shown when the study offers voice input; names who turns speech into text. */
    voice: { installation: string; browser: string; device: string };
  };
  interview: {
    phases: Record<InterviewPhase, string>;
    questionOf: (current: number, total: number) => string;
    finishEarly: string;
    srInterviewer: string;
    srYou: string;
    composing: string;
    completeTitle: string;
    completePreviewTitle: string;
    completeBody: string;
    completePreviewBody: string;
    continueSave: string;
    continuePreview: string;
    greetingFailed: string;
    replyFailed: string;
    tryAgain: string;
    responseLabel: string;
    placeholder: string;
    send: string;
    sendShortcut: string;
    voice: {
      start: string;
      stop: string;
      recording: (elapsed: string) => string;
      listening: string;
      transcribing: string;
      preparing: string;
      deviceUnavailable: string;
      review: string;
      denied: string;
      failed: string;
      unsupported: string;
      limited: string;
      unavailable: string;
    };
  };
  finish: {
    thankYouTitle: string;
    saved: string;
    contact: string;
    turns: string;
    elapsed: string;
    consentAccepted: string;
    saveFailedTitle: string;
    saveFailedBody: string;
    backToInterview: string;
    retrySave: string;
    finalizingTitle: string;
    finalizingBody: string;
  };
  defaults: {
    /** The consent text a study saves when this language's field is left blank. */
    consentText: (researchQuestion: string) => string;
    /** Rendered when the researcher wrote no thank-you text for this language. */
    thankYouText: (studyName: string) => string;
  };
}

export const en: Messages = {
  link: {
    loading: 'Loading interview...',
    unableTitle: 'Unable to Load Interview',
    checkLink: 'Please check that you have the correct link or contact the researcher.',
    noCode: 'No participant link code provided',
    invalid: 'Invalid or expired link',
    noSession: 'The participant session could not be established',
    transportUnknown: 'This study could not confirm how your responses are sent',
    loadFailed: 'Failed to load study configuration',
  },
  noSession: {
    title: 'This interview is not open in this tab',
    body: 'If you are taking part in a study, open the link you were given again. Answers not yet saved in this tab could not be kept.',
    cause: 'This happens when your browser cannot keep the interview for this tab, for example when storage for this site is blocked or full. Allowing it, or using another browser, avoids it.',
  },
  language: {
    label: 'Language',
    hint: 'The consent text, the interview and this page use the language you choose.',
  },
  consent: {
    label: 'Research consent',
    structureTitle: 'Interview Structure',
    background: 'Brief background questions',
    backgroundHint: 'Help us understand your context',
    coreQuestions: (count) => `${count} core question${count === 1 ? '' : 's'} about your experiences`,
    coreHint: 'The heart of the interview',
    followUps: 'The AI may ask follow-up questions',
    followUpsHint: 'To better understand your perspective',
    feedback: 'A final question for your feedback',
    feedbackHint: 'Your thoughts on the interview itself',
    estimatedTime: 'Estimated time: 10-15 minutes',
    dataNoticeLabel: 'Data notice:',
    controller: 'The researcher is the study\'s data controller and controls its storage and retention settings. Do not include information you do not want to share. Contact the researcher for retention, access, and deletion details.',
    researcherContact: 'Researcher contact:',
    unavailableSettings: 'This interview is unavailable until the researcher reviews and saves its AI provider settings.',
    unavailableReopen: 'This interview is unavailable until you reopen the study link.',
    back: 'Back',
    accept: 'I consent — begin the interview',
    recording: 'Recording consent…',
    opening: 'Opening the interview…',
    returning: 'Returning to study setup…',
    errors: {
      recordFailed: 'Consent could not be recorded. Please try again.',
      disclosureChanged: 'How this study sends your responses has changed since this page loaded. Reopen the study link to review the updated notice.',
      languageNotOffered: 'This study is not offered in that language. Reopen the study link.',
      unavailable: 'Consent could not be recorded right now. Please try again in a moment.',
      reopen: 'This page no longer matches the study. Reopen the study link.',
    },
    transport: {
      unconfirmed: 'This page could not confirm how your responses are sent. Reopen the study link before continuing.',
      notReady: 'The researcher must review and save this study\'s AI provider settings before interviews can begin.',
      cloudflareGatewayOpenRouter: 'Your responses are sent through Cloudflare AI Gateway, a relay operated by Cloudflare (which also hosts this study), to OpenRouter and a ZDR-compatible upstream inference provider selected for that model. The relay is configured not to log or cache your responses. Cloudflare may process them outside the EU.',
      cloudflareGateway: (provider) => `Your responses are sent to ${provider} through Cloudflare AI Gateway, a relay operated by Cloudflare, which also hosts this study. The relay is configured not to log or cache your responses and does not send them to any other provider. Cloudflare may process them outside the EU.`,
      vercelGateway: (provider) => `Your responses are sent through Vercel AI Gateway to ${provider}. Routing is pinned to that provider and model fallback is disabled.`,
      directOpenRouter: 'Your responses are sent to OpenRouter and a ZDR-compatible upstream inference provider selected for that model.',
      direct: (provider) => `Your responses are sent to ${provider}.`,
    },
    commitment: {
      fixedOpenRouter: (model) => `The interview and any later analysis of your responses use ${model} through OpenRouter; the study does not switch them to another AI service or model. OpenRouter may use a different ZDR-compatible upstream provider for each request.`,
      fixed: (model, provider) => `The interview and any later analysis of your responses use ${model} (${provider}); the study does not switch them to another AI provider or model.`,
      mayChange: 'The researcher may later analyze your responses with a different AI provider or model.',
    },
    voice: {
      device: 'If you use the microphone, your browser turns your speech into text on this computer and says the recording stays there. This study receives only the text you choose to send, never the recording. The first time, your browser may download a speech pack (about 60 MB).',
      installation: 'If you use the microphone, your recording is sent to Cloudflare to be turned into text by Cloudflare Workers AI. This study does not keep the recording, and you can edit the text before sending it.',
      browser: 'If you use the microphone, your browser\'s speech service turns your speech into text: in Chrome this is Google, in Safari Apple, under their own terms. You can edit the text before sending it.',
    },
  },
  interview: {
    phases: {
      background: 'Getting to know you',
      'core-questions': 'Core Questions',
      exploration: 'Exploring further',
      feedback: 'Your feedback',
      'wrap-up': 'Wrapping up',
    },
    questionOf: (current, total) => `Question ${current} of ${total}`,
    finishEarly: 'Finish early',
    srInterviewer: 'Interviewer:',
    srYou: 'You:',
    composing: 'Composing a follow-up…',
    completeTitle: 'Interview conversation complete',
    completePreviewTitle: 'Preview conversation complete',
    completeBody: 'Your responses have not been saved yet. Continue to finalize and save your interview. Keep this tab open until you see confirmation that it is safe to close.',
    completePreviewBody: 'Continue to generate the preview analysis. Preview responses will not be added to study data.',
    continueSave: 'Continue to save interview',
    continuePreview: 'Continue preview',
    greetingFailed: 'The interviewer could not start. This is not an AI reply — please try again.',
    replyFailed: 'The interviewer could not reply. Please try sending again.',
    tryAgain: 'Try again',
    responseLabel: 'Your response',
    placeholder: 'Take as much space as you need.',
    send: 'Send',
    sendShortcut: '⌘/Ctrl + Enter to send',
    voice: {
      preparing: 'Preparing speech on this device…',
      deviceUnavailable: 'Voice input is unavailable on this device. Please type your answer.',
      start: 'Start voice input',
      stop: 'Stop recording',
      recording: (elapsed) => `Recording ${elapsed} (up to 1:00)`,
      listening: 'Listening…',
      transcribing: 'Turning your recording into text…',
      review: 'Check the text before sending.',
      denied: 'Microphone access was blocked. Allow it in your browser, or type your answer.',
      failed: 'Your recording could not be turned into text. Please try again or type your answer.',
      unsupported: 'Voice input does not work in this browser. Please type your answer.',
      limited: 'You have recorded many answers in a short time. Please wait a little, or type your answer.',
      unavailable: 'Voice input is not available right now. Please type your answer.',
    },
  },
  finish: {
    thankYouTitle: 'Thank you',
    saved: 'Your responses have been saved. It is now safe to close this tab.',
    contact: 'Questions or concerns? Contact:',
    turns: 'Turns contributed',
    elapsed: 'Elapsed',
    consentAccepted: 'Consent accepted',
    saveFailedTitle: 'We couldn\'t save your interview',
    saveFailedBody: 'Your responses are still in this tab. Keep it open and retry the save before closing.',
    backToInterview: 'Back to interview',
    retrySave: 'Retry save',
    finalizingTitle: 'Finalizing your interview',
    finalizingBody: 'We are preparing and saving your responses. Keep this tab open until you see confirmation that it is safe to close.',
  },
  defaults: {
    consentText: (researchQuestion) => [
      'Thank you for participating in this research study. Your responses will be used to answer the following research question:',
      researchQuestion.trim(),
      'You may stop at any time. Do you consent to participate?',
    ].join('\n\n'),
    thankYouText: (studyName) => [
      'Thank you for taking part.',
      `Your responses will be used in the study "${studyName.trim()}".`,
    ].join('\n\n'),
  },
};
