-- Phase 08: the terminal size the IDE asks for when it opens a remote session, handed to the broker in the ticket
-- snapshot so the remote PTY starts at that size. Null for non-terminal sessions.
-- Never edit after merge (06 §5).

ALTER TABLE sessions
  ADD COLUMN terminal_cols int CHECK (terminal_cols BETWEEN 1 AND 1000),
  ADD COLUMN terminal_rows int CHECK (terminal_rows BETWEEN 1 AND 500),
  ADD CONSTRAINT sessions_terminal_size_both CHECK ((terminal_cols IS NULL) = (terminal_rows IS NULL));
