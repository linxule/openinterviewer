// Vercel KV (Redis) Client Setup
// Auto-provisioned during Vercel deployment

import { kv } from '@vercel/kv';
import { StoredInterview, StoredStudy } from '@/types';

// Key prefixes for organizing data
const INTERVIEW_PREFIX = 'interview:';
const STUDY_INDEX_PREFIX = 'study-interviews:';
const STUDY_PREFIX = 'study:';
const ALL_STUDIES_KEY = 'all-studies';

// Get interview by ID
export async function getInterview(id: string): Promise<StoredInterview | null> {
  try {
    return await kv.get<StoredInterview>(`${INTERVIEW_PREFIX}${id}`);
  } catch (error) {
    console.error('Error getting interview:', error);
    return null;
  }
}

// Save interview (create or update)
export async function saveInterview(interview: StoredInterview): Promise<boolean> {
  try {
    // Save the interview
    await kv.set(`${INTERVIEW_PREFIX}${interview.id}`, interview);

    // Add to study index for easy lookup by study
    await kv.sadd(`${STUDY_INDEX_PREFIX}${interview.studyId}`, interview.id);

    // Add to global index
    await kv.sadd('all-interviews', interview.id);

    return true;
  } catch (error) {
    console.error('Error saving interview:', error);
    return false;
  }
}

// Get all interviews
export async function getAllInterviews(): Promise<StoredInterview[]> {
  try {
    const ids = await kv.smembers('all-interviews');
    if (!ids || ids.length === 0) return [];

    const interviews = await Promise.all(
      ids.map(id => kv.get<StoredInterview>(`${INTERVIEW_PREFIX}${id}`))
    );

    return interviews
      .filter((i): i is StoredInterview => i !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    console.error('Error getting all interviews:', error);
    return [];
  }
}

// Get interviews for a specific study
export async function getStudyInterviews(studyId: string): Promise<StoredInterview[]> {
  try {
    const ids = await kv.smembers(`${STUDY_INDEX_PREFIX}${studyId}`);
    if (!ids || ids.length === 0) return [];

    const interviews = await Promise.all(
      ids.map(id => kv.get<StoredInterview>(`${INTERVIEW_PREFIX}${id}`))
    );

    return interviews
      .filter((i): i is StoredInterview => i !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    console.error('Error getting study interviews:', error);
    return [];
  }
}

// Delete interview
export async function deleteInterview(id: string, studyId: string): Promise<boolean> {
  try {
    await kv.del(`${INTERVIEW_PREFIX}${id}`);
    await kv.srem(`${STUDY_INDEX_PREFIX}${studyId}`, id);
    await kv.srem('all-interviews', id);
    return true;
  } catch (error) {
    console.error('Error deleting interview:', error);
    return false;
  }
}

// Check if KV is available (for development without KV)
export async function isKVAvailable(): Promise<boolean> {
  try {
    await kv.ping();
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Study Storage Functions
// ============================================

// Save study (create or update)
export async function saveStudy(study: StoredStudy): Promise<boolean> {
  try {
    await kv.set(`${STUDY_PREFIX}${study.id}`, study);
    await kv.sadd(ALL_STUDIES_KEY, study.id);
    return true;
  } catch (error) {
    console.error('Error saving study:', error);
    return false;
  }
}

// Get study by ID
export async function getStudy(id: string): Promise<StoredStudy | null> {
  try {
    return await kv.get<StoredStudy>(`${STUDY_PREFIX}${id}`);
  } catch (error) {
    console.error('Error getting study:', error);
    return null;
  }
}

// Get all studies
export async function getAllStudies(): Promise<StoredStudy[]> {
  try {
    const ids = await kv.smembers(ALL_STUDIES_KEY);
    if (!ids || ids.length === 0) return [];

    const studies = await Promise.all(
      ids.map(id => kv.get<StoredStudy>(`${STUDY_PREFIX}${id}`))
    );

    return studies
      .filter((s): s is StoredStudy => s !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    console.error('Error getting all studies:', error);
    return [];
  }
}

// Delete study (only if no interviews exist)
export async function deleteStudy(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Check for existing interviews
    const interviewIds = await kv.smembers(`${STUDY_INDEX_PREFIX}${id}`);
    if (interviewIds && interviewIds.length > 0) {
      return { success: false, error: 'Cannot delete study with existing interviews' };
    }

    await kv.del(`${STUDY_PREFIX}${id}`);
    await kv.srem(ALL_STUDIES_KEY, id);
    return { success: true };
  } catch (error) {
    console.error('Error deleting study:', error);
    return { success: false, error: 'Failed to delete study' };
  }
}

// Increment interview count for a study
export async function incrementStudyInterviewCount(studyId: string): Promise<boolean> {
  try {
    const study = await getStudy(studyId);
    if (!study) return false;

    study.interviewCount += 1;
    study.updatedAt = Date.now();
    return await saveStudy(study);
  } catch (error) {
    console.error('Error incrementing study interview count:', error);
    return false;
  }
}

// Lock study (prevent further edits after first interview)
export async function lockStudy(studyId: string): Promise<boolean> {
  try {
    const study = await getStudy(studyId);
    if (!study) return false;
    if (study.isLocked) return true; // Already locked

    study.isLocked = true;
    study.updatedAt = Date.now();
    return await saveStudy(study);
  } catch (error) {
    console.error('Error locking study:', error);
    return false;
  }
}
