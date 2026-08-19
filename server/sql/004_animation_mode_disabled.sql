-- Allow players to disable comparison animations while retaining sound settings.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_animation_mode_check;

ALTER TABLE users
  ADD CONSTRAINT users_animation_mode_check
  CHECK (animation_mode IN ('light', 'cinematic', 'disabled'));
