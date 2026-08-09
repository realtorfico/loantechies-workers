// Port of Leads/PreApprovalStatus.cs — the borrower-facing pre-approval status vocabulary,
// shared between EstimateGate (sets Submitted), document uploads (advances to Documents
// Received, Phase 4), and admin lead management (sets the rest). Centralized so every caller
// uses the exact same strings.
export const SUBMITTED = 'Submitted';
export const DOCUMENTS_RECEIVED = 'Documents Received';
export const UNDER_REVIEW = 'Under Review';
export const NEEDS_MORE_INFO = 'Needs More Info';
export const PRE_APPROVED = 'Pre-Approved';
// Terminal, Reg B-driven closures (§1002.9). Declined = an Adverse Action Notice was sent.
// Withdrawn = a Notice of Incompleteness (NeedsMoreInfo) went unanswered past its deadline.
export const DECLINED = 'Declined';
export const WITHDRAWN = 'Withdrawn';

// Linear order for "has this status already moved past X" checks. NeedsMoreInfo is a branch off
// UnderReview, not a forward step — excluded from the ordered progression (see isAtLeast).
const ORDER = [SUBMITTED, DOCUMENTS_RECEIVED, UNDER_REVIEW, PRE_APPROVED];

// Statuses an admin may set directly. Withdrawn is deliberately absent — only ever set
// automatically by the incompleteness-deadline sweep, never a direct admin action.
export const ADMIN_SETTABLE = new Set([UNDER_REVIEW, NEEDS_MORE_INFO, PRE_APPROVED, DECLINED]);

// True if `current` is already at or past `target` in the normal progression — guards against a
// later, lesser event (e.g. a fresh document upload) downgrading a status already advanced.
// Declined/Withdrawn are terminal — they count as "at least" any target.
export function isAtLeast(current, target) {
  if (!current) return false;
  if (current === DECLINED || current === WITHDRAWN) return true;
  if (current === NEEDS_MORE_INFO) current = UNDER_REVIEW;
  const curIdx = ORDER.indexOf(current);
  const targetIdx = ORDER.indexOf(target);
  return curIdx >= 0 && targetIdx >= 0 && curIdx >= targetIdx;
}
