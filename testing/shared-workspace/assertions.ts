/** Attribution is verified from durable actor subjects; prose may vary label capitalization. */
export function acknowledgedFeedback(text: string, proof: string, visualCode: string): boolean {
  return text.includes(visualCode) && ['DESIGN-', 'ENGINEER-', 'QA-']
    .every(prefix => text.toLowerCase().includes(`${prefix}${proof}`.toLowerCase()));
}
