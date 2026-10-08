import type { InterviewLanguage } from '../languages';
import { en, type Messages } from './en';
import { es } from './es';
import { fr } from './fr';
import { ja } from './ja';
import { ko } from './ko';
import { zh } from './zh';

export type { Messages } from './en';

export const MESSAGES: Record<InterviewLanguage, Messages> = { en, zh, fr, ja, ko, es };

export function messagesFor(language: InterviewLanguage | null | undefined): Messages {
  return (language && MESSAGES[language]) || en;
}
