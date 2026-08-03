-- Permanent account deletion retains sanitized operational audit events while
-- severing user identifiers. Grant only the two identifier columns required by
-- that process rather than broad UPDATE access to the audit ledger.
grant update (actor_id, subject_user_id)
    on munch.audit_events
    to munch_auth;
