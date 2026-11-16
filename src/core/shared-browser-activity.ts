import type { BrowserFrame } from '../domain/shared-browser.js';

/** Host-confirmed action, bound to a worker generation and resulting revision. */
export interface BrowserActionReceipt {
  epoch: string;
  revision: number;
  actor: { id: string; label: string };
  action: string;
}
export interface BrowserView extends BrowserFrame { last_action?: BrowserActionReceipt }

export const browserViewKey = (frame: Pick<BrowserFrame, 'epoch' | 'revision'>): string => `${frame.epoch}:${frame.revision}`;

/** A saved intent or an older collaborator action cannot claim a newer browser view. */
export function browserView(frame: BrowserFrame, completed?: BrowserActionReceipt): BrowserView {
  const { last_action: _untrusted, ...image } = frame as BrowserView;
  return { ...image, ...(completed?.epoch === frame.epoch && completed.revision === frame.revision ? { last_action: completed } : {}) };
}
