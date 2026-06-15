UPDATE api_keys
SET scopes = scopes - 'harness_identity'
WHERE scopes ? 'harness_identity';
