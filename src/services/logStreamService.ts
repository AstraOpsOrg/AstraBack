// In-process log stream service (SSE-only bridge)
import type { LogMessage } from '@/types';

class LogStreamService {
  private subscribers: Map<string, Set<(log: LogMessage) => void>> = new Map();
  private rawSubscribers: Map<string, Set<(line: string) => void>> = new Map();

  // Publish log message to all subscribers of a job
  publishLog(jobId: string, logMessage: LogMessage): void {
    // Notify in-process subscribers (SSE bridges)
    const callbacks = this.subscribers.get(jobId);
    if (callbacks && callbacks.size > 0) {
      for (const cb of callbacks) {
        try { cb(logMessage); } catch (e) { console.error('Subscriber callback error:', e); }
      }
    }
  }

  // Publish raw line to all subscribers (no JSON format)
  publishRaw(jobId: string, rawLine: string): void {
    // Notify in-process subscribers (SSE bridges)
    const rawCallbacks = this.rawSubscribers.get(jobId);
    if (rawCallbacks && rawCallbacks.size > 0) {
      for (const cb of rawCallbacks) {
        try { cb(rawLine); } catch (e) { console.error('Raw subscriber error:', e); }
      }
    }
  }

  // In-process subscription for logs per jobId (used by SSE endpoints)
  subscribeToLogs(jobId: string, callback: (log: LogMessage) => void): () => void {
    if (!this.subscribers.has(jobId)) {
      this.subscribers.set(jobId, new Set());
    }
    const callbacks = this.subscribers.get(jobId)!;
    callbacks.add(callback);

    // Return unsubscribe function
    return () => {
      const currentCallbacks = this.subscribers.get(jobId);
      if (currentCallbacks) {
        currentCallbacks.delete(callback);
        if (currentCallbacks.size === 0) this.subscribers.delete(jobId);
      }
    };
  }

  // In-process subscription for raw logs per jobId (used by SSE endpoints)
  subscribeToRaw(jobId: string, callback: (line: string) => void): () => void {
    if (!this.rawSubscribers.has(jobId)) {
      this.rawSubscribers.set(jobId, new Set());
    }
    const rawCallbacks = this.rawSubscribers.get(jobId)!;
    rawCallbacks.add(callback);
    return () => {
      const currentRawCallbacks = this.rawSubscribers.get(jobId);
      if (currentRawCallbacks) {
        currentRawCallbacks.delete(callback);
        if (currentRawCallbacks.size === 0) this.rawSubscribers.delete(jobId);
      }
    };
  }
}

export const logStreamService = new LogStreamService();