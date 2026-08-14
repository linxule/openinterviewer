// Demo Data for OpenInterviewer
// Provides realistic example study, interviews, and synthesis for demonstration

import {
  StoredStudy,
  StoredInterview,
  StudyConfig,
  InterviewMessage,
  SynthesisResult,
  ParticipantProfile,
  BehaviorData,
  AggregateSynthesisResult
} from '@/types';

// ============================================
// Demo Study Configuration
// ============================================

const DEMO_STUDY_ID = 'demo-study-adaptive-self';

export const DEMO_STUDY_CONFIG: StudyConfig = {
  id: DEMO_STUDY_ID,
  name: 'The Adaptive Self: Professional Identity in the Age of AI',
  description: 'Exploring how knowledge workers are adapting their professional identities and practices as AI tools become integral to their daily work. This study examines the psychological, practical, and social dimensions of AI adoption in creative and analytical professions.',
  researchQuestion: 'How are professionals redefining their value and identity as AI tools reshape the nature of their work?',
  coreQuestions: [
    'Tell me about a recent project where you used AI tools. What was your experience like?',
    'How has your daily work routine changed since you started using AI assistants?',
    'What aspects of your work do you feel AI handles well, and what do you prefer to do yourself?',
    'Have your colleagues or team adopted AI tools differently than you? How does that affect collaboration?',
    'Looking ahead, how do you see your professional role evolving alongside AI capabilities?'
  ],
  topicAreas: [
    'AI Tool Usage',
    'Professional Identity',
    'Workflow Changes',
    'Team Dynamics',
    'Future Outlook'
  ],
  profileSchema: [
    { id: 'role', label: 'Current Role', extractionHint: 'Their job title or professional role', required: true },
    { id: 'industry', label: 'Industry', extractionHint: 'The field or industry they work in', required: true },
    { id: 'ai_frequency', label: 'AI Usage Frequency', extractionHint: 'How often they use AI tools (daily, weekly, etc.)', required: true, options: ['Daily', 'Several times a week', 'Weekly', 'Monthly', 'Rarely'] },
    { id: 'comfort_level', label: 'Comfort with AI', extractionHint: 'Their self-reported comfort level with AI tools', required: false, options: ['Very comfortable', 'Comfortable', 'Neutral', 'Uncomfortable', 'Very uncomfortable'] },
    { id: 'years_experience', label: 'Years in Role', extractionHint: 'How long they have been in their current role or profession', required: false }
  ],
  aiBehavior: 'standard',
  aiProvider: 'gemini',
  enableReasoning: true,
  consentText: 'This interview is part of a research study on professional adaptation to AI tools. Your responses will be anonymized and used for research purposes only. The interview takes approximately 15-20 minutes. You may skip any question or end the interview at any time.',
  createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000 // 7 days ago
};

export const DEMO_STORED_STUDY: StoredStudy = {
  id: DEMO_STUDY_ID,
  config: DEMO_STUDY_CONFIG,
  createdAt: DEMO_STUDY_CONFIG.createdAt,
  updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
  interviewCount: 3,
  isLocked: true,
  revision: 1
};

// ============================================
// Demo Interview 1: Sarah - Product Manager
// ============================================

const SARAH_PROFILE: ParticipantProfile = {
  id: 'profile-sarah',
  fields: [
    { fieldId: 'role', value: 'Product Manager', status: 'extracted', extractedAt: Date.now() - 5 * 24 * 60 * 60 * 1000 },
    { fieldId: 'industry', value: 'Fintech Startup', status: 'extracted', extractedAt: Date.now() - 5 * 24 * 60 * 60 * 1000 },
    { fieldId: 'ai_frequency', value: 'Daily', status: 'extracted', extractedAt: Date.now() - 5 * 24 * 60 * 60 * 1000 },
    { fieldId: 'comfort_level', value: 'Very comfortable', status: 'extracted', extractedAt: Date.now() - 5 * 24 * 60 * 60 * 1000 },
    { fieldId: 'years_experience', value: '6 years', status: 'extracted', extractedAt: Date.now() - 5 * 24 * 60 * 60 * 1000 }
  ],
  rawContext: 'Sarah is a senior product manager at a fintech startup with 6 years of experience. She uses Claude daily for drafting specs, analyzing user feedback, and brainstorming product strategies. Very enthusiastic about AI and sees it as empowering rather than threatening.',
  timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000
};

const SARAH_TRANSCRIPT: InterviewMessage[] = [
  { id: 'msg-s1', role: 'ai', content: "Hello! Thank you for participating in this research interview about professional experiences with AI tools. I'm curious to learn about your work and how AI has been part of your journey. To start, could you tell me a bit about your current role?", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 },
  { id: 'msg-s2', role: 'user', content: "Sure! I'm a product manager at a fintech startup. Been doing this for about 6 years now, the last 2 at this company. We're building tools for small business lending.", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 60000 },
  { id: 'msg-s3', role: 'ai', content: "That's fascinating work - fintech is such a dynamic space. Now, I'd love to hear about a recent project where you used AI tools. What was that experience like for you?", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 120000 },
  { id: 'msg-s4', role: 'user', content: "Oh, I use Claude literally every day now. Last week I was working on a major product spec for our new credit scoring feature. I used it to analyze about 200 pieces of user feedback, draft the initial spec, and even help me think through edge cases. What used to take me 3-4 days took maybe 8 hours.", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 180000 },
  { id: 'msg-s5', role: 'ai', content: "That's a remarkable efficiency gain. I'm curious though - when you say it helped you 'think through edge cases,' how did that work? Did it feel like collaborating with a colleague?", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 240000 },
  { id: 'msg-s6', role: 'user', content: "Hmm, it's different from a colleague. With a colleague there's back and forth, pushback, their own experiences. With Claude it's more like... a really well-read assistant who never gets tired of my questions? It surfaces things I might miss, but I'm still the one making judgment calls.", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 300000 },
  { id: 'msg-s7', role: 'ai', content: "That distinction feels important - you maintaining the judgment while it handles the breadth. How has this changed your daily work routine since you started using these tools?", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 360000 },
  { id: 'msg-s8', role: 'user', content: "Honestly? I spend way more time on strategy now. Before, so much of my day was just... processing. Reading tickets, summarizing meetings, drafting emails. Now I can do those in a fraction of the time and actually think about the bigger picture. It's like I got promoted without changing jobs.", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 420000 },
  { id: 'msg-s9', role: 'ai', content: "'Got promoted without changing jobs' - I love that framing. But I'm also curious if there's a flip side. Anything you've lost or that feels different in a way you didn't expect?", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 480000 },
  { id: 'msg-s10', role: 'user', content: "That's a good question. Sometimes I worry I'm losing some muscle. Like, my writing used to be really sharp because I did so much of it. Now when I write something from scratch it feels... rustier? Though maybe that's just because I'm comparing it to Claude's output.", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 540000 },
  { id: 'msg-s11', role: 'ai', content: "That tension between capability and skill maintenance is really interesting. Let me ask about your team - have your colleagues adopted AI tools differently than you? How does that affect how you all work together?", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 600000 },
  { id: 'msg-s12', role: 'user', content: "It's mixed! Our engineers use Copilot a lot but are skeptical about other AI. My CEO is a huge AI enthusiast, maybe even more than me. But some of our more senior folks barely touch it. It creates this weird dynamic where I can turn around work so fast that others can't keep up, and I have to be careful not to make them feel slow.", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 660000 },
  { id: 'msg-s13', role: 'ai', content: "So there's a social dimension to navigate too - being mindful of how your AI-enabled speed might affect team dynamics. Looking ahead, how do you see your professional role evolving as these capabilities continue to develop?", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 720000 },
  { id: 'msg-s14', role: 'user', content: "I genuinely feel optimistic. I think PMs who embrace AI will become more like mini-CEOs - we'll have so much more capacity to think strategically, make connections, understand users deeply. The ones who don't... honestly, they'll get left behind. Not because AI replaces them, but because AI-enabled PMs will just outperform.", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 780000 },
  { id: 'msg-s15', role: 'ai', content: "It sounds like you see AI as an amplifier rather than a replacement - expanding what's possible for those who adopt it. Before we wrap up, is there anything else about your experience with AI in your work that you'd like to share?", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 840000 },
  { id: 'msg-s16', role: 'user', content: "Just that I think we're still at the very beginning. When I imagine what work will look like in 5 years, I genuinely can't picture it. But I know I want to be someone who helped shape that future rather than just reacting to it.", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 900000 },
  { id: 'msg-s17', role: 'ai', content: "That forward-looking, agency-oriented perspective is really compelling. Thank you so much for sharing your experiences and insights, Sarah. This has been a rich conversation about navigating AI in professional life.", timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 + 960000 }
];

const SARAH_SYNTHESIS: SynthesisResult = {
  statedPreferences: [
    'Values strategic thinking over routine processing tasks',
    'Prefers maintaining judgment and decision-making authority',
    'Wants to be proactive in shaping AI-influenced future',
    'Values efficiency gains from AI tools'
  ],
  revealedPreferences: [
    'Derives professional identity from high-level strategic work',
    'Cares about team dynamics and not making others feel inadequate',
    'Has some anxiety about skill atrophy despite enthusiasm',
    'Sees AI adoption as competitive differentiation'
  ],
  themes: [
    { theme: 'Role Elevation', evidence: '"It\'s like I got promoted without changing jobs" - AI enables more strategic focus', frequency: 4 },
    { theme: 'Skill Tension', evidence: 'Worries about writing feeling "rustier" - capability vs. skill maintenance', frequency: 2 },
    { theme: 'Team Navigation', evidence: 'Careful not to make slower colleagues "feel slow" - social awareness', frequency: 2 },
    { theme: 'Competitive Framing', evidence: 'Non-adopters "will get left behind" - AI as professional differentiator', frequency: 3 }
  ],
  contradictions: [
    'Enthusiastic about AI\'s benefits while expressing concern about losing personal skills',
    'Sees AI as empowering but frames non-adoption as professionally dangerous'
  ],
  keyInsights: [
    'AI adoption is experienced as capability expansion rather than replacement',
    'Speed differential creates social dynamics that require active management',
    'Skill atrophy concern persists even among enthusiastic adopters',
    'Professional identity is shifting from "doer" to "strategic thinker"'
  ],
  bottomLine: 'Sarah represents the enthusiastic AI adopter who has successfully reframed AI tools as capability amplifiers, enabling a shift toward more strategic work. However, beneath the enthusiasm lies nuanced concerns about skill maintenance and team dynamics.'
};

const SARAH_BEHAVIOR: BehaviorData = {
  timePerTopic: {
    'AI Tool Usage': 180000,
    'Professional Identity': 240000,
    'Workflow Changes': 180000,
    'Team Dynamics': 120000,
    'Future Outlook': 180000
  },
  messagesPerTopic: {
    'AI Tool Usage': 4,
    'Professional Identity': 4,
    'Workflow Changes': 3,
    'Team Dynamics': 2,
    'Future Outlook': 3
  },
  topicsExplored: ['AI Tool Usage', 'Professional Identity', 'Workflow Changes', 'Team Dynamics', 'Future Outlook'],
  contradictions: ['Enthusiasm vs. skill atrophy concern']
};

export const SARAH_INTERVIEW: StoredInterview = {
  id: 'interview-demo-sarah',
  studyId: DEMO_STUDY_ID,
  studyName: DEMO_STUDY_CONFIG.name,
  participantProfile: SARAH_PROFILE,
  transcript: SARAH_TRANSCRIPT,
  synthesis: SARAH_SYNTHESIS,
  behaviorData: SARAH_BEHAVIOR,
  createdAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
  completedAt: Date.now() - 5 * 24 * 60 * 60 * 1000 + 1200000,
  status: 'completed'
};

// ============================================
// Demo Interview 2: Marcus - UX Designer
// ============================================

const MARCUS_PROFILE: ParticipantProfile = {
  id: 'profile-marcus',
  fields: [
    { fieldId: 'role', value: 'Senior UX Designer', status: 'extracted', extractedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 },
    { fieldId: 'industry', value: 'Enterprise Software', status: 'extracted', extractedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 },
    { fieldId: 'ai_frequency', value: 'Several times a week', status: 'extracted', extractedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 },
    { fieldId: 'comfort_level', value: 'Comfortable', status: 'extracted', extractedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 },
    { fieldId: 'years_experience', value: '12 years', status: 'extracted', extractedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 }
  ],
  rawContext: 'Marcus is a senior UX designer with 12 years of experience in enterprise software. Initially skeptical of AI tools, he has gradually adopted them for ideation and iteration. Maintains strong beliefs about the irreplaceable value of human judgment in design.',
  timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000
};

const MARCUS_TRANSCRIPT: InterviewMessage[] = [
  { id: 'msg-m1', role: 'ai', content: "Welcome! I appreciate you taking the time for this interview. We're exploring how professionals are experiencing AI tools in their work. Could you start by telling me about your role?", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 },
  { id: 'msg-m2', role: 'user', content: "I'm a senior UX designer, been doing this for about 12 years now. Currently at an enterprise software company - we build tools for healthcare administration.", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 60000 },
  { id: 'msg-m3', role: 'ai', content: "That's a lot of experience in a field that values deep expertise. I'd love to hear about a recent project where you used AI tools - what was that experience like?", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 120000 },
  { id: 'msg-m4', role: 'user', content: "Honestly, I was a skeptic for a long time. 'AI can't do real design' was basically my stance. But our team lead pushed us to try Midjourney for ideation. I was... surprised. In one session I generated probably 100 visual directions in an hour. Normally that would take days of sketching.", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 180000 },
  { id: 'msg-m5', role: 'ai', content: "That's quite a shift from skepticism! When you saw those 100 directions, what was going through your mind? How did it feel?", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 240000 },
  { id: 'msg-m6', role: 'user', content: "Mixed feelings. Part of me was like, 'wow, this is amazing for exploration.' But another part felt almost... threatened? Like if I can do in an hour what used to take days, what does that say about the value of my days?", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 300000 },
  { id: 'msg-m7', role: 'ai', content: "That tension between amazement and threat is so human. How did you resolve that, or are you still working through it?", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 360000 },
  { id: 'msg-m8', role: 'user', content: "I think I've landed somewhere useful. The AI can generate variations infinitely, but it can't tell which one actually solves the user's problem. That's still me. It's like having an incredibly fast sketch artist who has no taste - I provide the taste.", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 420000 },
  { id: 'msg-m9', role: 'ai', content: "'I provide the taste' - that's a powerful reframe. Has this changed your daily workflow at all?", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 480000 },
  { id: 'msg-m10', role: 'user', content: "Definitely. I iterate much faster now. Where I used to bring 3 concepts to a stakeholder meeting, I can bring 15 and refine in real-time based on their feedback. It's made the design process more collaborative somehow, because there's less preciousness about any single direction.", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 540000 },
  { id: 'msg-m11', role: 'ai', content: "Less preciousness - that's interesting. It sounds like AI might be changing not just the speed but the emotional relationship with work. How have your colleagues adapted compared to you?", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 600000 },
  { id: 'msg-m12', role: 'user', content: "Split down the middle. Junior designers love it - they feel like they can punch above their weight. But some of my senior peers are really resistant. One guy literally said 'I didn't spend 15 years mastering Photoshop to have a machine do it.' I get it, but I also think that's a losing battle.", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 660000 },
  { id: 'msg-m13', role: 'ai', content: "You understand their resistance but see it as futile. Looking ahead, how do you see the designer role evolving?", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 720000 },
  { id: 'msg-m14', role: 'user', content: "I think designers become more like creative directors. Less hands-on-tools, more guiding and curating. The craft part - pushing pixels, precise execution - that's getting automated. What stays human is understanding people, making judgment calls, telling stories. If you can only push pixels, yeah, you're in trouble.", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 780000 },
  { id: 'msg-m15', role: 'ai', content: "The shift from execution to judgment and curation. Is there anything you're doing differently to prepare for that future?", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 840000 },
  { id: 'msg-m16', role: 'user', content: "Yeah, actually. I'm spending more time on research, user interviews, understanding context. The stuff that AI can't just generate. And honestly, rediscovering why I got into design in the first place - it was never about the tools, it was about solving problems for people.", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 900000 },
  { id: 'msg-m17', role: 'ai', content: "That's a beautiful reconnection with purpose. Thank you for sharing such an honest journey from skepticism to integration, Marcus. Your insights about taste, judgment, and the evolution of design expertise are really valuable.", timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 + 960000 }
];

const MARCUS_SYNTHESIS: SynthesisResult = {
  statedPreferences: [
    'Values human judgment and "taste" as irreplaceable',
    'Prefers collaborative, iterative design processes',
    'Wants to focus on user understanding over tool mastery',
    'Believes in adapting to change rather than resisting'
  ],
  revealedPreferences: [
    'Needed external push to try AI tools despite skepticism',
    'Found initial threat response diminished when he reframed his value',
    'Empathizes with resistant colleagues while viewing their stance as futile',
    'Returning to design fundamentals as a response to AI change'
  ],
  themes: [
    { theme: 'Skeptic Conversion', evidence: '"AI can\'t do real design" to "100 directions in an hour" - external push led to reevaluation', frequency: 3 },
    { theme: 'Value Reframe', evidence: '"I provide the taste" - separating generation from judgment', frequency: 4 },
    { theme: 'Reduced Preciousness', evidence: 'More concepts, less attachment, more collaborative', frequency: 2 },
    { theme: 'Generational Split', evidence: 'Juniors embrace, seniors resist - different relationships to craft', frequency: 2 }
  ],
  contradictions: [
    'Sees resistant colleagues\' stance as futile while deeply understanding it',
    'Values craft mastery while acknowledging its diminishing importance'
  ],
  keyInsights: [
    'External forcing functions can convert AI skeptics through direct experience',
    'Reframing personal value proposition (taste vs. generation) resolves threat feelings',
    'AI tools may reduce emotional attachment to individual designs, enabling better collaboration',
    'Senior professionals face identity crisis when craft skills become automated'
  ],
  bottomLine: 'Marcus represents the converted skeptic who found peace by reframing his value from execution to judgment. His journey suggests that direct experience, combined with new mental models, can transform AI resistance into productive adoption.'
};

const MARCUS_BEHAVIOR: BehaviorData = {
  timePerTopic: {
    'AI Tool Usage': 240000,
    'Professional Identity': 300000,
    'Workflow Changes': 120000,
    'Team Dynamics': 120000,
    'Future Outlook': 180000
  },
  messagesPerTopic: {
    'AI Tool Usage': 4,
    'Professional Identity': 5,
    'Workflow Changes': 2,
    'Team Dynamics': 2,
    'Future Outlook': 3
  },
  topicsExplored: ['AI Tool Usage', 'Professional Identity', 'Workflow Changes', 'Team Dynamics', 'Future Outlook'],
  contradictions: ['Understanding resistance while seeing it as futile']
};

export const MARCUS_INTERVIEW: StoredInterview = {
  id: 'interview-demo-marcus',
  studyId: DEMO_STUDY_ID,
  studyName: DEMO_STUDY_CONFIG.name,
  participantProfile: MARCUS_PROFILE,
  transcript: MARCUS_TRANSCRIPT,
  synthesis: MARCUS_SYNTHESIS,
  behaviorData: MARCUS_BEHAVIOR,
  createdAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
  completedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 + 1200000,
  status: 'completed'
};

// ============================================
// Demo Interview 3: Priya - Content Manager
// ============================================

const PRIYA_PROFILE: ParticipantProfile = {
  id: 'profile-priya',
  fields: [
    { fieldId: 'role', value: 'Content Manager', status: 'extracted', extractedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 },
    { fieldId: 'industry', value: 'Digital Media', status: 'extracted', extractedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 },
    { fieldId: 'ai_frequency', value: 'Daily', status: 'extracted', extractedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 },
    { fieldId: 'comfort_level', value: 'Comfortable', status: 'extracted', extractedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 },
    { fieldId: 'years_experience', value: '8 years', status: 'extracted', extractedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 }
  ],
  rawContext: 'Priya is a content manager at a digital media company with 8 years of experience. Uses AI daily for drafts but maintains strong editorial oversight. Wrestling with tensions between efficiency and authenticity, particularly around audience trust.',
  timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000
};

const PRIYA_TRANSCRIPT: InterviewMessage[] = [
  { id: 'msg-p1', role: 'ai', content: "Hello! Thanks for joining this research interview. We're exploring how professionals are navigating AI in their work. Could you tell me about your current role?", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 },
  { id: 'msg-p2', role: 'user', content: "I'm a content manager at a digital media company - we do news and lifestyle content. Been in content/editorial for about 8 years total.", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 60000 },
  { id: 'msg-p3', role: 'ai', content: "Content and media is right at the heart of the AI conversation. I'd love to hear about a recent project where you used AI tools - what was your experience?", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 120000 },
  { id: 'msg-p4', role: 'user', content: "We use AI every day for first drafts. I'll take a topic, feed in research materials and our style guide, and get a draft back in minutes instead of hours. My job has shifted from writing to editing and refining.", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 180000 },
  { id: 'msg-p5', role: 'ai', content: "That's a significant shift - from creator to editor. How do you feel about that change in your role?", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 240000 },
  { id: 'msg-p6', role: 'user', content: "Complicated. On one hand, we can produce 3x the content. On the other... I got into this because I love writing. Now I spend more time fixing AI prose than crafting my own. It's efficient but sometimes feels hollow.", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 300000 },
  { id: 'msg-p7', role: 'ai', content: "'Efficient but hollow' - that's a striking way to put it. Can you tell me more about what feels hollow?", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 360000 },
  { id: 'msg-p8', role: 'user', content: "There's something about struggling with a sentence, finding just the right word... that creative friction feels important. Now I sometimes publish pieces that are technically fine but that I don't feel ownership over. Like I'm a machine operator, not a writer.", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 420000 },
  { id: 'msg-p9', role: 'ai', content: "The loss of creative ownership and struggle. Does this affect how you think about your audience?", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 480000 },
  { id: 'msg-p10', role: 'user', content: "That's actually my biggest tension. Our readers trust us for authentic perspective. If they knew how much was AI-assisted, would they still trust us? We don't disclose it, and that feels... not quite right. But also, the edited output IS my perspective, isn't it?", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 540000 },
  { id: 'msg-p11', role: 'ai', content: "You're wrestling with real transparency and authenticity questions. How does this play out with your team?", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 600000 },
  { id: 'msg-p12', role: 'user', content: "We don't really talk about it openly. Everyone uses AI, but there's this unspoken sense of... shame? Like it's a dirty secret. Which is weird because management explicitly encourages it for efficiency. But old journalistic values die hard.", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 660000 },
  { id: 'msg-p13', role: 'ai', content: "That gap between official encouragement and unspoken shame is fascinating. Looking forward, how do you see content work evolving?", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 720000 },
  { id: 'msg-p14', role: 'user', content: "I think disclosure is coming whether we like it or not. Readers will demand it. And honestly, maybe that's good - it forces us to be clear about where human value actually is. The investigative pieces, the deeply human stories, the original perspectives - that's what I want to focus on.", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 780000 },
  { id: 'msg-p15', role: 'ai', content: "So the pressure might clarify where human contribution truly matters. What are you doing to prepare for that clarity?", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 840000 },
  { id: 'msg-p16', role: 'user', content: "I'm actively trying to protect time for the human-only work. Real interviews, original reporting, essays with genuine voice. It's harder because AI can fill any time you give it, but I think those skills are what will matter most.", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 900000 },
  { id: 'msg-p17', role: 'ai', content: "Protecting space for irreducibly human work while AI expands everywhere else. Thank you for such a thoughtful and honest conversation, Priya. Your reflections on authenticity, disclosure, and the changing nature of creative work are really valuable.", timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 + 960000 }
];

const PRIYA_SYNTHESIS: SynthesisResult = {
  statedPreferences: [
    'Values authentic voice and original perspective',
    'Believes in transparency with audiences',
    'Wants to focus on uniquely human journalism',
    'Efficiency is valuable but not sufficient'
  ],
  revealedPreferences: [
    'Complicit in non-disclosure despite discomfort',
    'Misses the creative struggle of writing',
    'Feels loss of ownership over published work',
    'Tension between professional practice and personal values'
  ],
  themes: [
    { theme: 'Authenticity Crisis', evidence: '"Efficient but hollow" - volume gains at cost of creative ownership', frequency: 4 },
    { theme: 'Disclosure Tension', evidence: 'Non-disclosure "feels not quite right" - unresolved ethical question', frequency: 3 },
    { theme: 'Organizational Shame', evidence: '"Unspoken sense of shame" despite management encouragement', frequency: 2 },
    { theme: 'Protective Strategy', evidence: 'Actively protecting time for "human-only work"', frequency: 2 }
  ],
  contradictions: [
    'Uses AI daily while feeling it undermines authentic voice',
    'Values transparency while participating in non-disclosure',
    'Management encourages AI use while team feels shame about it'
  ],
  keyInsights: [
    'AI adoption can create ethical tensions around authenticity and disclosure',
    'Creative professions may experience loss of ownership and identity',
    'Organizational cultures can simultaneously mandate and stigmatize AI use',
    'Future clarity about human value may come from external pressure (disclosure requirements)'
  ],
  bottomLine: 'Priya represents the ethically conflicted adopter who uses AI extensively while harboring real concerns about authenticity and disclosure. Her experience highlights how AI efficiency can hollow out creative satisfaction even while boosting productivity.'
};

const PRIYA_BEHAVIOR: BehaviorData = {
  timePerTopic: {
    'AI Tool Usage': 180000,
    'Professional Identity': 360000,
    'Workflow Changes': 60000,
    'Team Dynamics': 120000,
    'Future Outlook': 180000
  },
  messagesPerTopic: {
    'AI Tool Usage': 3,
    'Professional Identity': 6,
    'Workflow Changes': 1,
    'Team Dynamics': 2,
    'Future Outlook': 3
  },
  topicsExplored: ['AI Tool Usage', 'Professional Identity', 'Workflow Changes', 'Team Dynamics', 'Future Outlook'],
  contradictions: ['Daily use vs. authenticity concerns', 'Values transparency vs. participates in non-disclosure']
};

export const PRIYA_INTERVIEW: StoredInterview = {
  id: 'interview-demo-priya',
  studyId: DEMO_STUDY_ID,
  studyName: DEMO_STUDY_CONFIG.name,
  participantProfile: PRIYA_PROFILE,
  transcript: PRIYA_TRANSCRIPT,
  synthesis: PRIYA_SYNTHESIS,
  behaviorData: PRIYA_BEHAVIOR,
  createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
  completedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 + 1200000,
  status: 'completed'
};

// ============================================
// Demo Aggregate Synthesis
// ============================================

export const DEMO_AGGREGATE_SYNTHESIS: AggregateSynthesisResult = {
  studyId: DEMO_STUDY_ID,
  studyRevision: 1,
  interviewIds: ['demo-interview-1', 'demo-interview-2', 'demo-interview-3'],
  interviewCount: 3,
  aiProvider: 'gemini',
  aiModel: 'demo-scripted',
  commonThemes: [
    {
      theme: 'Role Evolution from Execution to Judgment',
      frequency: 3,
      representativeQuotes: [
        '"It\'s like I got promoted without changing jobs" - Sarah',
        '"I provide the taste" - Marcus',
        '"My job has shifted from writing to editing and refining" - Priya'
      ]
    },
    {
      theme: 'Skill Atrophy Concerns',
      frequency: 3,
      representativeQuotes: [
        '"My writing used to be really sharp... now it feels rustier" - Sarah',
        '"I didn\'t spend 15 years mastering Photoshop to have a machine do it" - Marcus\'s colleague',
        '"I spend more time fixing AI prose than crafting my own" - Priya'
      ]
    },
    {
      theme: 'Social Navigation Required',
      frequency: 3,
      representativeQuotes: [
        '"I have to be careful not to make them feel slow" - Sarah',
        '"Junior designers love it... senior peers are really resistant" - Marcus',
        '"There\'s this unspoken sense of shame" - Priya'
      ]
    },
    {
      theme: 'Identity Reframing as Adaptation Strategy',
      frequency: 3,
      representativeQuotes: [
        '"PMs who embrace AI will become more like mini-CEOs" - Sarah',
        '"Designers become more like creative directors" - Marcus',
        '"Investigative pieces, deeply human stories - that\'s what I want to focus on" - Priya'
      ]
    }
  ],
  divergentViews: [
    {
      topic: 'Emotional Relationship with AI',
      viewA: 'Sarah: Enthusiastic amplifier - AI as pure capability expansion',
      viewB: 'Priya: Conflicted user - AI as efficiency gain with authenticity costs'
    },
    {
      topic: 'Path to Adoption',
      viewA: 'Sarah: Self-driven early adopter, intrinsically motivated',
      viewB: 'Marcus: Skeptic converted through external push and direct experience'
    },
    {
      topic: 'Transparency Concerns',
      viewA: 'Sarah & Marcus: Focused on personal capability, not disclosure',
      viewB: 'Priya: Wrestling with ethical questions about audience trust'
    }
  ],
  keyFindings: [
    'AI adoption triggers identity renegotiation across all professions studied, with professionals redefining their value from execution to judgment, curation, and strategic thinking',
    'Even enthusiastic adopters harbor concerns about skill atrophy, suggesting this is a near-universal anxiety regardless of adoption stance',
    'AI speed differentials create new social dynamics in teams, requiring active management and creating generational tensions',
    'Different professions face different ethical tensions - creative/media fields especially grapple with authenticity and disclosure questions',
    'Successful adaptation involves finding new mental models ("I provide the taste," "mini-CEO") that preserve professional identity while incorporating AI capabilities'
  ],
  researchImplications: [
    'Training programs should address both tool proficiency and identity/value reframing',
    'Organizations need explicit norms around AI disclosure and team dynamics',
    'Future research should explore how skill atrophy concerns affect long-term career development',
    'Industry-specific ethical frameworks for AI use may be needed, especially in creative/media fields'
  ],
  bottomLine: 'Across three knowledge workers in different fields, AI adoption emerges as fundamentally an identity challenge rather than a skills challenge. All participants successfully use AI tools, but their deeper work involves redefining professional value and navigating social and ethical complexities. The enthusiastic (Sarah), converted skeptic (Marcus), and ethically conflicted (Priya) represent different positions on a shared journey of professional redefinition in the AI age.',
  generatedAt: Date.now() - 1 * 24 * 60 * 60 * 1000
};

// ============================================
// Export Arrays for Seeding
// ============================================

export const DEMO_STUDIES: StoredStudy[] = [DEMO_STORED_STUDY];
export const DEMO_INTERVIEWS: StoredInterview[] = [SARAH_INTERVIEW, MARCUS_INTERVIEW, PRIYA_INTERVIEW];
