-- Attribute historical traffic that predates API keys being bound to their
-- creator. Until now createApiKey discarded the actor, so every key had a null
-- user_id and all requests collapsed into "Unknown user" on the Cost page.

-- 1. Bind each unowned key to the user who created it, recovered from the
--    api_key.created audit event. Only adopt a creator that still exists as a
--    user so the FK (user_id -> users.id) stays valid.
UPDATE api_keys AS k
SET user_id = e.actor_id
FROM events AS e
WHERE k.user_id IS NULL
  AND e.event_type = 'api_key.created'
  AND e.scope_type = 'api_key'
  AND e.scope_id = k.id
  AND e.actor_type = 'user'
  AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = e.actor_id);

-- 2. Propagate the now-known owner to traffic rows that are still unattributed.
--    requests and usage_ledger carry the api_key_id directly; agent_sessions
--    inherit from the requests they hold.
UPDATE requests AS r
SET user_id = k.user_id
FROM api_keys AS k
WHERE r.user_id IS NULL
  AND r.api_key_id = k.id
  AND k.user_id IS NOT NULL;

UPDATE usage_ledger AS l
SET user_id = r.user_id
FROM requests AS r
WHERE l.user_id IS NULL
  AND l.request_id = r.id
  AND r.user_id IS NOT NULL;

UPDATE agent_sessions AS s
SET user_id = sub.user_id
FROM (
  SELECT DISTINCT ON (session_id) session_id, user_id
  FROM requests
  WHERE session_id IS NOT NULL
    AND user_id IS NOT NULL
  ORDER BY session_id, created_at
) AS sub
WHERE s.user_id IS NULL
  AND s.id = sub.session_id;
