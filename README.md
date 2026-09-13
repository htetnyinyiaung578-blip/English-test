# English Test

This is a no-build English test website with Supabase realtime monitoring.

## Features

- Up to 3 shared question papers and 70 questions per paper
- Multiple choice, true/false, fill-in-the-blank, short answer, matching, and ordering questions
- Explanation / Manual Review questions with teacher-assigned marks
- Type-specific automatic grading with case-insensitive text answers
- Automatic total marks
- Learner name or ID, hidden questions until a paper starts, answer autosave, refresh-safe progress, scoring, and submission
- Live creator monitor with learner identity, paper, answered/unanswered questions, current answers, progress, status, and final score

## Supabase setup

1. Create a Supabase project at https://supabase.com.
2. Copy the project URL and anon key from **Project Settings > API** into `supabase-config.js`.
3. Open the Supabase SQL Editor and run `supabase-schema.sql`.
4. Create the admin account under **Authentication > Users** using email and password. If email confirmation is enabled, confirm the verification email before signing in.
5. In **Database > Replication**, enable realtime for the `papers` and `attempts` tables.
6. Students do not sign in. The SQL policies allow anonymous students to create/update attempts and only authenticated admins to read/delete attempts or manage papers.

If this project was already configured, rerun `supabase-schema.sql` or apply its `Admins can delete attempts` policy in Supabase so the Live Monitor delete action is permitted.

Question definitions are stored in the existing `papers.questions` JSONB column. Existing questions without a `type` field remain compatible and are treated as multiple choice. Run `supabase-schema.sql` after this update to add the `attempts.manual_marks` JSONB column and the student-owned attempt read policy used for database-backed resume/review recovery. The student identity is stored as a random browser-local identifier and sent as `x-student-id`; answers and statuses remain in Supabase.

## Run

Serve the folder over HTTP because ES modules and OAuth do not work reliably from `file://` URLs:

```powershell
npx serve .
```

Open the local URL printed by the command. The Supabase anon key is safe for browser use when the RLS policies are configured correctly. Never put a service-role key in this project.
