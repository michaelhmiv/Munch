-- Shared Pantry records outlive individual household members. Actor attribution
-- becomes nullable when an account is deleted rather than blocking deletion.

alter table munch.inventory_spaces
    drop constraint if exists inventory_spaces_created_by_user_id_fkey;
alter table munch.inventory_spaces
    alter column created_by_user_id drop not null;
alter table munch.inventory_spaces
    add constraint inventory_spaces_created_by_user_id_fkey
    foreign key (created_by_user_id) references munch.users(id) on delete set null;

alter table munch.inventory_items
    drop constraint if exists inventory_items_created_by_user_id_fkey;
alter table munch.inventory_items
    drop constraint if exists inventory_items_updated_by_user_id_fkey;
alter table munch.inventory_items
    alter column created_by_user_id drop not null,
    alter column updated_by_user_id drop not null;
alter table munch.inventory_items
    add constraint inventory_items_created_by_user_id_fkey
    foreign key (created_by_user_id) references munch.users(id) on delete set null;
alter table munch.inventory_items
    add constraint inventory_items_updated_by_user_id_fkey
    foreign key (updated_by_user_id) references munch.users(id) on delete set null;

alter table munch.inventory_events
    drop constraint if exists inventory_events_actor_user_id_fkey;
alter table munch.inventory_events
    alter column actor_user_id drop not null;
alter table munch.inventory_events
    add constraint inventory_events_actor_user_id_fkey
    foreign key (actor_user_id) references munch.users(id) on delete set null;

alter table munch.purchase_reconciliations
    drop constraint if exists purchase_reconciliations_created_by_user_id_fkey;
alter table munch.purchase_reconciliations
    alter column created_by_user_id drop not null;
alter table munch.purchase_reconciliations
    add constraint purchase_reconciliations_created_by_user_id_fkey
    foreign key (created_by_user_id) references munch.users(id) on delete set null;
