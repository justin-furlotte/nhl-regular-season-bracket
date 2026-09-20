-- =====================================================================
-- NHL Standings Predictor: database schema, security rules, and functions
--
-- Run this in the Supabase dashboard: SQL Editor > New query > paste > Run.
-- It is safe to re-run after edits (tables/seed rows are created only if
-- missing; functions and policies are replaced).
--
-- Security model: the browser can only READ tables (filtered by row-level
-- security). Every write goes through the functions below, which run
-- server-side and re-check every rule (league size, one locked submission,
-- deadline, valid picks). Nothing the browser does can bypass them.
-- =====================================================================

-- ---------- Reference data ----------

create table if not exists public.seasons (
  id             text primary key,                      -- e.g. '2026-27'
  games_per_team int  not null check (games_per_team > 0),
  picks_close_at timestamptz not null                   -- submissions rejected after this moment
);

create table if not exists public.teams (
  code     text primary key,                            -- 'BOS'
  division text not null                                -- 'Atlantic'
);

-- Opening night 2026-27: Sept 29, first puck at 5:00 p.m. ET (Florida at Carolina).
insert into public.seasons (id, games_per_team, picks_close_at)
values ('2026-27', 84, timestamp '2026-09-29 17:00:00' at time zone 'America/New_York')
on conflict (id) do nothing;

insert into public.teams (code, division) values
  ('BOS','Atlantic'),('BUF','Atlantic'),('DET','Atlantic'),('FLA','Atlantic'),
  ('MTL','Atlantic'),('OTT','Atlantic'),('TBL','Atlantic'),('TOR','Atlantic'),
  ('CAR','Metropolitan'),('CBJ','Metropolitan'),('NJD','Metropolitan'),('NYI','Metropolitan'),
  ('NYR','Metropolitan'),('PHI','Metropolitan'),('PIT','Metropolitan'),('WSH','Metropolitan'),
  ('CHI','Central'),('COL','Central'),('DAL','Central'),('MIN','Central'),
  ('NSH','Central'),('STL','Central'),('UTA','Central'),('WPG','Central'),
  ('ANA','Pacific'),('CGY','Pacific'),('EDM','Pacific'),('LAK','Pacific'),
  ('SJS','Pacific'),('SEA','Pacific'),('VAN','Pacific'),('VGK','Pacific')
on conflict (code) do nothing;

-- ---------- Users, leagues, submissions ----------

-- One profile per Google account. Stores only a display name and avatar,
-- never the email address.
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_url   text
);

create table if not exists public.leagues (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  season_id   text not null references public.seasons (id),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at  timestamptz not null default now()
);

create table if not exists public.league_members (
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (league_id, user_id)
);
create index if not exists league_members_user_idx on public.league_members (user_id);

-- One locked submission per player per season. There is deliberately no way
-- to update or delete a row from the browser.
create table if not exists public.submissions (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  season_id    text not null references public.seasons (id),
  picks        jsonb not null,                          -- {"BOS": {"points": 101, "position": 2}, ...}
  submitted_at timestamptz not null default now(),
  primary key (user_id, season_id)
);

-- Create a profile automatically the first time someone signs in with Google.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''),
             nullif(new.raw_user_meta_data ->> 'name', ''),
             nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
             'Player'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who signed in before this script ran.
insert into public.profiles (id, display_name, avatar_url)
select u.id,
       coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''),
                nullif(u.raw_user_meta_data ->> 'name', ''),
                nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
                'Player'),
       coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture')
from auth.users u
on conflict (id) do nothing;

-- ---------- League size limit (12 players) ----------
-- Locks the league row so two people joining at the same moment can't both
-- take the last seat.

create or replace function public.enforce_league_size()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.leagues where id = new.league_id for update;
  if (select count(*) from public.league_members where league_id = new.league_id) >= 12 then
    raise exception 'This league is full (12 players max)';
  end if;
  return new;
end;
$$;

drop trigger if exists league_size_check on public.league_members;
create trigger league_size_check
  before insert on public.league_members
  for each row execute function public.enforce_league_size();

-- ---------- Helpers ----------

create or replace function public.is_league_member(p_league uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.league_members
    where league_id = p_league and user_id = auth.uid()
  );
$$;

create or replace function public.current_season()
returns text
language sql
stable
set search_path = ''
as $$
  select id from public.seasons order by picks_close_at desc limit 1;
$$;

-- Throws a readable error unless the picks are complete and valid.
create or replace function public.validate_picks(p_picks jsonb, p_games int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r            record;
  v_entry      jsonb;
  v_pts        numeric;
  v_pos        numeric;
  v_total      numeric := 0;
  v_team_count int;
  v_div_size   int;
begin
  if p_picks is null or jsonb_typeof(p_picks) <> 'object' then
    raise exception 'Picks must be an object keyed by team code';
  end if;

  select count(*) into v_team_count from public.teams;
  if (select count(*) from jsonb_object_keys(p_picks)) <> v_team_count then
    raise exception 'Picks must include exactly % teams', v_team_count;
  end if;

  for r in select t.code, t.division from public.teams t order by t.code loop
    v_entry := p_picks -> r.code;
    if v_entry is null or jsonb_typeof(v_entry) <> 'object' then
      raise exception 'Missing picks for %', r.code;
    end if;
    if coalesce(jsonb_typeof(v_entry -> 'points'), '') <> 'number'
       or coalesce(jsonb_typeof(v_entry -> 'position'), '') <> 'number' then
      raise exception 'Points and position must be numbers for %', r.code;
    end if;

    v_pts := (v_entry ->> 'points')::numeric;
    v_pos := (v_entry ->> 'position')::numeric;

    if v_pts <> trunc(v_pts) or v_pts < 0 or v_pts > p_games * 2 then
      raise exception 'Points for % must be a whole number from 0 to %', r.code, p_games * 2;
    end if;

    select count(*) into v_div_size from public.teams where division = r.division;
    if v_pos <> trunc(v_pos) or v_pos < 1 or v_pos > v_div_size then
      raise exception 'Position for % must be a whole number from 1 to %', r.code, v_div_size;
    end if;

    v_total := v_total + v_pts;
  end loop;

  -- Every spot in every division used exactly once.
  if exists (
    select 1 from public.teams t
    group by t.division
    having count(distinct (p_picks -> t.code ->> 'position')::numeric) <> count(*)
  ) then
    raise exception 'Each position in a division must be used exactly once';
  end if;

  -- 2 points per regulation game, 3 per overtime game, two teams per game.
  if v_total < p_games * v_team_count or v_total > p_games * v_team_count * 3 / 2 then
    raise exception 'Total points must be between % and %',
      p_games * v_team_count, p_games * v_team_count * 3 / 2;
  end if;
end;
$$;

-- ---------- Actions the browser may call ----------

create or replace function public.create_league(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_id   uuid;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'League name must be 1 to 60 characters';
  end if;
  if (select count(*) from public.leagues where owner_id = v_uid) >= 10 then
    raise exception 'You can own at most 10 leagues';
  end if;

  insert into public.leagues (name, season_id, owner_id)
  values (v_name, public.current_season(), v_uid)
  returning id into v_id;

  insert into public.league_members (league_id, user_id) values (v_id, v_uid);
  return v_id;
end;
$$;

create or replace function public.join_league(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;

  select id into v_id from public.leagues where invite_code = upper(btrim(coalesce(p_code, '')));
  if v_id is null then raise exception 'No league found with that invite code'; end if;

  -- Already a member: nothing to do.
  if exists (select 1 from public.league_members where league_id = v_id and user_id = v_uid) then
    return v_id;
  end if;

  insert into public.league_members (league_id, user_id) values (v_id, v_uid);  -- size checked by trigger
  return v_id;
end;
$$;

create or replace function public.submit_picks(p_picks jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_season public.seasons%rowtype;
  v_at     timestamptz;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;

  select * into v_season from public.seasons where id = public.current_season();
  if now() >= v_season.picks_close_at then
    raise exception 'Picks are closed for the % season', v_season.id;
  end if;

  perform public.validate_picks(p_picks, v_season.games_per_team);

  insert into public.submissions (user_id, season_id, picks)
  values (v_uid, v_season.id, p_picks)
  on conflict (user_id, season_id) do nothing
  returning submitted_at into v_at;

  if v_at is null then
    raise exception 'You have already submitted your picks. They are locked for the season.';
  end if;
  return v_at;
end;
$$;

-- Members of a league, and whether each has submitted. Reveals nothing about
-- anyone's actual picks.
create or replace function public.league_overview(p_league uuid)
returns table (member_id uuid, display_name text, avatar_url text, is_owner boolean, has_submitted boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id,
         p.display_name,
         p.avatar_url,
         (l.owner_id = m.user_id),
         (s.user_id is not null)
  from public.league_members m
  join public.leagues  l on l.id = m.league_id
  join public.profiles p on p.id = m.user_id
  left join public.submissions s on s.user_id = m.user_id and s.season_id = l.season_id
  where m.league_id = p_league
    and public.is_league_member(p_league)
  order by m.joined_at;
$$;

-- ---------- Row-level security (what the browser may read) ----------

alter table public.seasons        enable row level security;
alter table public.teams          enable row level security;
alter table public.profiles       enable row level security;
alter table public.leagues        enable row level security;
alter table public.league_members enable row level security;
alter table public.submissions    enable row level security;

drop policy if exists seasons_read on public.seasons;
create policy seasons_read on public.seasons for select to anon, authenticated using (true);

drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams for select to anon, authenticated using (true);

-- You can see your own profile and profiles of people in your leagues.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (
  id = (select auth.uid())
  or exists (select 1 from public.league_members m where m.user_id = profiles.id)
);

drop policy if exists leagues_read on public.leagues;
create policy leagues_read on public.leagues for select to authenticated using (
  public.is_league_member(id)
);

drop policy if exists league_members_read on public.league_members;
create policy league_members_read on public.league_members for select to authenticated using (
  public.is_league_member(league_id)
);

-- Your own submission any time. Other players' submissions only after picks
-- close, and only if you share a league (so nobody can copy anyone).
drop policy if exists submissions_read on public.submissions;
create policy submissions_read on public.submissions for select to authenticated using (
  user_id = (select auth.uid())
  or (
    now() >= (select se.picks_close_at from public.seasons se where se.id = submissions.season_id)
    and exists (
      select 1
      from public.league_members mine
      join public.league_members theirs on theirs.league_id = mine.league_id
      where mine.user_id = (select auth.uid())
        and theirs.user_id = submissions.user_id
    )
  )
);

-- ---------- Permissions ----------
-- Read-only table access; all writes go through the functions above.

revoke all on public.seasons, public.teams, public.profiles, public.leagues,
              public.league_members, public.submissions from anon, authenticated;
grant select on public.seasons, public.teams to anon, authenticated;
grant select on public.profiles, public.leagues, public.league_members, public.submissions to authenticated;

revoke all on function public.handle_new_user()          from public, anon, authenticated;
revoke all on function public.enforce_league_size()      from public, anon, authenticated;
revoke all on function public.current_season()           from public, anon, authenticated;
revoke all on function public.validate_picks(jsonb, int) from public, anon, authenticated;

revoke all on function public.is_league_member(uuid)     from public, anon;
revoke all on function public.create_league(text)        from public, anon;
revoke all on function public.join_league(text)          from public, anon;
revoke all on function public.submit_picks(jsonb)        from public, anon;
revoke all on function public.league_overview(uuid)      from public, anon;

grant execute on function public.is_league_member(uuid)  to authenticated;
grant execute on function public.create_league(text)     to authenticated;
grant execute on function public.join_league(text)       to authenticated;
grant execute on function public.submit_picks(jsonb)     to authenticated;
grant execute on function public.league_overview(uuid)   to authenticated;
