create extension if not exists pgcrypto;

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  student_id text not null unique,
  taker_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.papers (
  id text primary key,
  title text not null,
  questions jsonb not null default '[]'::jsonb,
  owner_id uuid references auth.users(id),
  timer_enabled boolean not null default false,
  time_limit_minutes integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  student_id text,
  taker_name text not null,
  paper_id text not null,
  paper_title text not null,
  questions jsonb not null default '[]'::jsonb,
  question_count integer not null default 0,
  answers jsonb not null default '{}'::jsonb,
  manual_marks jsonb not null default '{}'::jsonb,
  current_index integer not null default 0,
  status text not null default 'in-progress',
  score integer,
  total_marks integer,
  percentage integer,
  time_limit_minutes integer not null default 0,
  started_at timestamptz,
  deadline_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz
);

alter table public.students enable row level security;
alter table public.papers enable row level security;
alter table public.attempts enable row level security;

alter table public.papers add column if not exists timer_enabled boolean not null default false;
alter table public.papers add column if not exists time_limit_minutes integer not null default 0;
alter table public.attempts add column if not exists student_id text;
alter table public.attempts add column if not exists manual_marks jsonb not null default '{}'::jsonb;
alter table public.attempts add column if not exists time_limit_minutes integer not null default 0;
alter table public.attempts add column if not exists started_at timestamptz;
alter table public.attempts add column if not exists deadline_at timestamptz;

create unique index if not exists students_user_id_idx on public.students(user_id);
create unique index if not exists students_student_id_idx on public.students(student_id);
create index if not exists attempts_user_id_idx on public.attempts(user_id);
create index if not exists attempts_student_id_idx on public.attempts(student_id);
create index if not exists attempts_deadline_at_idx on public.attempts(deadline_at);

-- Reset policies to safe, minimal defaults.
drop policy if exists "Anyone can read papers" on public.papers;
drop policy if exists "Admins can create papers" on public.papers;
drop policy if exists "Admins can update papers" on public.papers;
drop policy if exists "Admins can delete papers" on public.papers;
drop policy if exists "Students can create own student profile" on public.students;
drop policy if exists "Students can read own student profile" on public.students;
drop policy if exists "Students can update own student profile" on public.students;
drop policy if exists "Students can create attempts" on public.attempts;
drop policy if exists "Students can update attempts" on public.attempts;
drop policy if exists "Admins can read attempts" on public.attempts;
drop policy if exists "Admins can delete attempts" on public.attempts;
drop policy if exists "Students can read own attempts" on public.attempts;

create policy "Anyone can read papers"
  on public.papers for select using (true);
create policy "Admins can create papers"
  on public.papers for insert to authenticated with check (owner_id = auth.uid());
create policy "Admins can update papers"
  on public.papers for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "Admins can delete papers"
  on public.papers for delete to authenticated using (owner_id = auth.uid());

create policy "Students can create own student profile"
  on public.students for insert to anon, authenticated
  with check (user_id = coalesce(current_setting('request.headers', true)::json->>'x-student-id', ''));

create policy "Students can read own student profile"
  on public.students for select to anon, authenticated
  using (user_id = coalesce(current_setting('request.headers', true)::json->>'x-student-id', ''));

create policy "Students can update own student profile"
  on public.students for update to anon, authenticated
  using (user_id = coalesce(current_setting('request.headers', true)::json->>'x-student-id', ''))
  with check (user_id = coalesce(current_setting('request.headers', true)::json->>'x-student-id', ''));

create policy "Students can create attempts"
  on public.attempts for insert to anon, authenticated
  with check (
    user_id = coalesce(current_setting('request.headers', true)::json->>'x-student-id', '')
  );

create policy "Students can update attempts"
  on public.attempts for update to anon, authenticated
  using (user_id = coalesce(current_setting('request.headers', true)::json->>'x-student-id', ''))
  with check (
    user_id = coalesce(current_setting('request.headers', true)::json->>'x-student-id', '')
  );

create policy "Admins can read attempts"
  on public.attempts for select to authenticated using (true);

create policy "Students can read own attempts"
  on public.attempts for select to anon, authenticated
  using (
    user_id = coalesce(current_setting('request.headers', true)::json->>'x-student-id', '')
  );

create policy "Admins can delete attempts"
  on public.attempts for delete to authenticated using (true);

alter table public.papers replica identity full;
alter table public.attempts replica identity full;

notify pgrst, 'reload schema';

-- Questions remain in the existing papers.questions JSONB column. New records use
-- type-specific fields (options/correctAnswer, acceptedAnswers, pairs, or items),
-- while records without type continue to be treated as multiple choice.
-- In Supabase Dashboard: Database > Replication, enable papers and attempts.
