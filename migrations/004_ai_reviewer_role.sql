-- A distinct role for automated reviewers. Kept separate from 'reviewer' so that
-- automated checks can never be mistaken for a person's.
ALTER TYPE core.user_role ADD VALUE IF NOT EXISTS 'ai_reviewer';
