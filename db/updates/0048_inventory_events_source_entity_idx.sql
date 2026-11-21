-- Index pantry draw-down lookup and reversal checks on meal deletion.
create index if not exists inventory_events_source_entity_idx
    on munch.inventory_events (source_entity_id)
    where source_entity_id is not null;

create index if not exists inventory_events_reversal_of_idx
    on munch.inventory_events (reversal_of_event_id)
    where reversal_of_event_id is not null;
