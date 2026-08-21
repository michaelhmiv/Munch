-- Optional username aliases for Better Auth credential accounts.
-- Existing magic-link users remain valid with a null username.

alter table munch.users
    add column if not exists username text,
    add column if not exists display_username text;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'users_username_format'
    ) then
        alter table munch.users
            add constraint users_username_format
            check (
                username is null
                or (
                    username = lower(btrim(username))
                    and length(username) between 3 and 40
                    and username ~ '^[a-z0-9_.]+$'
                )
            );
    end if;
end
$$;

create unique index if not exists users_username_unique
    on munch.users (username)
    where username is not null;
