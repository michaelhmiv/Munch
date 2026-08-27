-- User reports for AI-generated content shown inside Munch.
-- Store only the generated excerpt being reported, never source Pantry contents,
-- prompts, images, bearer credentials, or unrelated nutrition history.

create table if not exists munch.ai_content_reports (
    id uuid primary key,
    user_id uuid not null references munch.users(id) on delete cascade,
    surface text not null,
    content_excerpt text not null,
    reason text not null,
    details text,
    status text not null default 'open',
    created_at timestamptz not null default now(),
    reviewed_at timestamptz,
    constraint ai_content_reports_surface check (
        surface in ('pantry_meal_idea')
    ),
    constraint ai_content_reports_excerpt_length check (
        length(content_excerpt) between 1 and 2000
    ),
    constraint ai_content_reports_reason check (
        reason in ('offensive', 'unsafe', 'misleading', 'other')
    ),
    constraint ai_content_reports_details_length check (
        details is null or length(details) between 1 and 1000
    ),
    constraint ai_content_reports_status check (
        status in ('open', 'reviewed', 'dismissed')
    )
);

create index if not exists ai_content_reports_open_idx
    on munch.ai_content_reports (status, created_at desc);
create index if not exists ai_content_reports_user_idx
    on munch.ai_content_reports (user_id, created_at desc);

alter table munch.ai_content_reports enable row level security;
alter table munch.ai_content_reports force row level security;

create policy ai_content_reports_app_insert
    on munch.ai_content_reports
    for insert
    to munch_app
    with check (user_id = munch.current_user_id());

create policy ai_content_reports_support_select
    on munch.ai_content_reports
    for select
    to munch_support
    using (true);

create policy ai_content_reports_support_update
    on munch.ai_content_reports
    for update
    to munch_support
    using (true)
    with check (true);

grant insert on munch.ai_content_reports to munch_app;
grant select, update on munch.ai_content_reports to munch_support;

comment on table munch.ai_content_reports is
    'User-submitted reports of specific AI-generated output; source prompts, Pantry contents, and images are intentionally excluded.';
