// Storage Service - Client-side interface for interview storage
// Calls API routes which interact with Vercel KV

import { StoredInterview, StoredStudy } from '@/types';

export type StudyDeleteResult = {
  success: boolean;
  pending?: boolean;
  operationId?: string;
  error?: string;
};

export type StudyReconciliationResult = {
  success: boolean;
  completed: number;
  rolledBack: number;
  stillPending: number;
  error?: string;
};

// Save completed interview
export async function saveCompletedInterview(
  interview: Omit<StoredInterview, 'completedAt' | 'status'>,
  participantToken?: string | null,
  researcherPreview = false,
  participantSessionHandle?: string | null
): Promise<{ success: boolean; id: string; preview?: boolean }> {
  try {
    const response = await fetch('/api/interviews/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(researcherPreview ? { 'X-OpenInterviewer-Preview': '1' } : {}),
        ...(!researcherPreview && participantSessionHandle
          ? { 'X-OpenInterviewer-Participant-Session': participantSessionHandle }
          : {}),
      },
      body: JSON.stringify({
        ...interview,
        completedAt: Date.now(),
        status: 'completed'
      })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error saving interview:', error);
    return { success: false, id: '' };
  }
}

// Get all interviews (researcher only)
export async function getAllInterviews(): Promise<StoredInterview[]> {
  try {
    const response = await fetch('/api/interviews');

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.interviews || [];
  } catch (error) {
    console.error('Error fetching interviews:', error);
    return [];
  }
}

// Get single interview by ID
export async function getInterview(id: string): Promise<StoredInterview | null> {
  try {
    const response = await fetch(`/api/interviews/${id}`);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.interview || null;
  } catch (error) {
    console.error('Error fetching interview:', error);
    return null;
  }
}

// Export all interviews as ZIP
export async function exportAllInterviews(): Promise<Blob | null> {
  try {
    const response = await fetch('/api/interviews/export');

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return await response.blob();
  } catch (error) {
    console.error('Error exporting interviews:', error);
    return null;
  }
}

// Get interviews for a specific study
export async function getStudyInterviews(studyId: string): Promise<StoredInterview[]> {
  try {
    const response = await fetch(`/api/interviews?studyId=${encodeURIComponent(studyId)}`);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.interviews || [];
  } catch (error) {
    console.error('Error fetching study interviews:', error);
    return [];
  }
}

// Get all studies (researcher only)
export async function getAllStudies(): Promise<{ studies: StoredStudy[]; warning?: string }> {
  try {
    const response = await fetch('/api/studies');

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      studies: data.studies || [],
      warning: data.warning
    };
  } catch (error) {
    console.error('Error fetching studies:', error);
    return { studies: [] };
  }
}

// Get single study by ID
export async function getStudy(id: string): Promise<StoredStudy | null> {
  try {
    const response = await fetch(`/api/studies/${id}`);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.study || null;
  } catch (error) {
    console.error('Error fetching study:', error);
    return null;
  }
}

// Delete study
export async function deleteStudy(id: string): Promise<StudyDeleteResult> {
  try {
    const response = await fetch(`/api/studies/${id}`, {
      method: 'DELETE'
    });
    const data = await response.json().catch(() => ({})) as {
      error?: string;
      message?: string;
      reconciliationPending?: boolean;
      operationId?: string;
    };

    if (response.status === 202 || data.reconciliationPending || data.operationId) {
      return {
        success: false,
        pending: true,
        operationId: data.operationId,
        error: data.message || data.error || 'Study deletion is awaiting reconciliation.',
      };
    }

    if (!response.ok) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch (error) {
    console.error('Error deleting study:', error);
    return { success: false, error: 'Failed to delete study' };
  }
}

// Repair a bounded batch of hosted study create/delete operations. The API is
// authenticated and rate-limited; callers use this on workspace entry and for
// explicit retries after a surfaced 202/pending response.
export async function reconcileStudyOperations(): Promise<StudyReconciliationResult> {
  try {
    const response = await fetch('/api/studies/reconcile', { method: 'POST' });
    const data = await response.json().catch(() => ({})) as {
      completed?: number;
      rolledBack?: number;
      stillPending?: number;
      error?: string;
    };
    if (!response.ok) {
      return {
        success: false,
        completed: 0,
        rolledBack: 0,
        stillPending: 0,
        error: data.error || 'Study reconciliation is temporarily unavailable.',
      };
    }
    return {
      success: true,
      completed: Number.isSafeInteger(data.completed) ? data.completed! : 0,
      rolledBack: Number.isSafeInteger(data.rolledBack) ? data.rolledBack! : 0,
      stillPending: Number.isSafeInteger(data.stillPending) ? data.stillPending! : 0,
    };
  } catch (error) {
    console.error('Error reconciling study operations:', error);
    return {
      success: false,
      completed: 0,
      rolledBack: 0,
      stillPending: 0,
      error: 'Study reconciliation is temporarily unavailable.',
    };
  }
}
