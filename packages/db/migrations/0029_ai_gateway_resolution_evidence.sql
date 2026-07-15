ALTER TABLE requests
  ADD COLUMN ingress_wire_id text,
  ADD COLUMN operation_id text,
  ADD COLUMN requested_logical_model text,
  ADD COLUMN resolved_logical_model_id text,
  ADD COLUMN access_profile_id text,
  ADD COLUMN router_kind text,
  ADD COLUMN deployment_id text,
  ADD COLUMN provider_connection_id text,
  ADD COLUMN egress_wire_id text,
  ADD COLUMN wire_adapter_version text;

ALTER TABLE requests
  ADD CONSTRAINT requests_resolved_logical_model_fk
    FOREIGN KEY (organization_id, workspace_id, resolved_logical_model_id)
      REFERENCES logical_models(organization_id, workspace_id, id),
  ADD CONSTRAINT requests_access_profile_fk
    FOREIGN KEY (organization_id, workspace_id, access_profile_id)
      REFERENCES access_profiles(organization_id, workspace_id, id),
  ADD CONSTRAINT requests_physical_target_fk
    FOREIGN KEY (organization_id, workspace_id, deployment_id, provider_connection_id)
      REFERENCES model_deployments(organization_id, workspace_id, id, provider_connection_id),
  ADD CONSTRAINT requests_egress_binding_fk
    FOREIGN KEY (organization_id, workspace_id, deployment_id, egress_wire_id)
      REFERENCES deployment_wire_bindings(organization_id, workspace_id, deployment_id, api_wire_id),
  ADD CONSTRAINT requests_gateway_admission_evidence_chk
    CHECK (
      (ingress_wire_id IS NULL AND operation_id IS NULL AND requested_logical_model IS NULL) OR
      (ingress_wire_id IS NOT NULL AND operation_id IS NOT NULL AND requested_logical_model IS NOT NULL)
    ),
  ADD CONSTRAINT requests_gateway_resolution_evidence_chk
    CHECK (
      (
        resolved_logical_model_id IS NULL AND access_profile_id IS NULL AND router_kind IS NULL AND
        deployment_id IS NULL AND provider_connection_id IS NULL AND egress_wire_id IS NULL AND
        wire_adapter_version IS NULL
      ) OR (
        ingress_wire_id IS NOT NULL AND operation_id IS NOT NULL AND requested_logical_model IS NOT NULL AND
        resolved_logical_model_id IS NOT NULL AND access_profile_id IS NOT NULL AND deployment_id IS NOT NULL AND
        provider_connection_id IS NOT NULL AND egress_wire_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT requests_ingress_wire_chk
    CHECK (ingress_wire_id IS NULL OR ingress_wire_id IN ('anthropic-messages', 'openai-responses', 'openai-chat', 'bedrock-converse')),
  ADD CONSTRAINT requests_operation_chk
    CHECK (operation_id IS NULL OR operation_id IN ('text.generate', 'text.count_tokens', 'model.list')),
  ADD CONSTRAINT requests_router_kind_chk
    CHECK (router_kind IS NULL OR router_kind = 'classifier'),
  ADD CONSTRAINT requests_egress_wire_chk
    CHECK (egress_wire_id IS NULL OR egress_wire_id IN ('anthropic-messages', 'openai-responses', 'openai-chat', 'bedrock-converse')),
  ADD CONSTRAINT requests_wire_adapter_version_chk
    CHECK (wire_adapter_version IS NULL OR (wire_adapter_version = btrim(wire_adapter_version) AND wire_adapter_version <> ''));

CREATE INDEX requests_org_workspace_logical_model_created_idx
  ON requests (organization_id, workspace_id, resolved_logical_model_id, created_at);
CREATE UNIQUE INDEX requests_org_workspace_id_idx
  ON requests (organization_id, workspace_id, id);

ALTER TABLE route_decisions
  ADD COLUMN ingress_wire_id text,
  ADD COLUMN operation_id text,
  ADD COLUMN requested_logical_model text,
  ADD COLUMN resolved_logical_model_id text,
  ADD COLUMN access_profile_id text,
  ADD COLUMN router_kind text,
  ADD COLUMN deployment_id text,
  ADD COLUMN provider_connection_id text,
  ADD COLUMN egress_wire_id text,
  ADD COLUMN wire_adapter_version text;

ALTER TABLE route_decisions
  ADD CONSTRAINT route_decisions_request_scope_fk
    FOREIGN KEY (organization_id, workspace_id, request_id)
      REFERENCES requests(organization_id, workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT route_decisions_resolved_logical_model_fk
    FOREIGN KEY (organization_id, workspace_id, resolved_logical_model_id)
      REFERENCES logical_models(organization_id, workspace_id, id),
  ADD CONSTRAINT route_decisions_access_profile_fk
    FOREIGN KEY (organization_id, workspace_id, access_profile_id)
      REFERENCES access_profiles(organization_id, workspace_id, id),
  ADD CONSTRAINT route_decisions_physical_target_fk
    FOREIGN KEY (organization_id, workspace_id, deployment_id, provider_connection_id)
      REFERENCES model_deployments(organization_id, workspace_id, id, provider_connection_id),
  ADD CONSTRAINT route_decisions_egress_binding_fk
    FOREIGN KEY (organization_id, workspace_id, deployment_id, egress_wire_id)
      REFERENCES deployment_wire_bindings(organization_id, workspace_id, deployment_id, api_wire_id),
  ADD CONSTRAINT route_decisions_gateway_admission_evidence_chk
    CHECK (
      (ingress_wire_id IS NULL AND operation_id IS NULL AND requested_logical_model IS NULL) OR
      (ingress_wire_id IS NOT NULL AND operation_id IS NOT NULL AND requested_logical_model IS NOT NULL)
    ),
  ADD CONSTRAINT route_decisions_gateway_resolution_evidence_chk
    CHECK (
      (
        resolved_logical_model_id IS NULL AND access_profile_id IS NULL AND router_kind IS NULL AND
        deployment_id IS NULL AND provider_connection_id IS NULL AND egress_wire_id IS NULL AND
        wire_adapter_version IS NULL
      ) OR (
        ingress_wire_id IS NOT NULL AND operation_id IS NOT NULL AND requested_logical_model IS NOT NULL AND
        resolved_logical_model_id IS NOT NULL AND access_profile_id IS NOT NULL AND deployment_id IS NOT NULL AND
        provider_connection_id IS NOT NULL AND egress_wire_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT route_decisions_ingress_wire_chk
    CHECK (ingress_wire_id IS NULL OR ingress_wire_id IN ('anthropic-messages', 'openai-responses', 'openai-chat', 'bedrock-converse')),
  ADD CONSTRAINT route_decisions_operation_chk
    CHECK (operation_id IS NULL OR operation_id IN ('text.generate', 'text.count_tokens', 'model.list')),
  ADD CONSTRAINT route_decisions_router_kind_chk
    CHECK (router_kind IS NULL OR router_kind = 'classifier'),
  ADD CONSTRAINT route_decisions_egress_wire_chk
    CHECK (egress_wire_id IS NULL OR egress_wire_id IN ('anthropic-messages', 'openai-responses', 'openai-chat', 'bedrock-converse')),
  ADD CONSTRAINT route_decisions_wire_adapter_version_chk
    CHECK (wire_adapter_version IS NULL OR (wire_adapter_version = btrim(wire_adapter_version) AND wire_adapter_version <> ''));

CREATE INDEX route_decisions_org_workspace_logical_model_idx
  ON route_decisions (organization_id, workspace_id, resolved_logical_model_id);

ALTER TABLE provider_attempts
  ADD COLUMN deployment_id text,
  ADD COLUMN provider_connection_id text,
  ADD COLUMN egress_wire_id text,
  ADD COLUMN provider_adapter_contract_version text;

ALTER TABLE provider_attempts
  ADD CONSTRAINT provider_attempts_request_scope_fk
    FOREIGN KEY (organization_id, workspace_id, request_id)
      REFERENCES requests(organization_id, workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT provider_attempts_physical_target_fk
    FOREIGN KEY (organization_id, workspace_id, deployment_id, provider_connection_id)
      REFERENCES model_deployments(organization_id, workspace_id, id, provider_connection_id),
  ADD CONSTRAINT provider_attempts_egress_binding_fk
    FOREIGN KEY (organization_id, workspace_id, deployment_id, egress_wire_id)
      REFERENCES deployment_wire_bindings(organization_id, workspace_id, deployment_id, api_wire_id),
  ADD CONSTRAINT provider_attempts_gateway_evidence_chk
    CHECK (
      (
        deployment_id IS NULL AND provider_connection_id IS NULL AND egress_wire_id IS NULL AND
        provider_adapter_contract_version IS NULL
      ) OR (
        deployment_id IS NOT NULL AND provider_connection_id IS NOT NULL AND egress_wire_id IS NOT NULL AND
        provider_adapter_contract_version IS NOT NULL
      )
    ),
  ADD CONSTRAINT provider_attempts_egress_wire_chk
    CHECK (egress_wire_id IS NULL OR egress_wire_id IN ('anthropic-messages', 'openai-responses', 'openai-chat', 'bedrock-converse')),
  ADD CONSTRAINT provider_attempts_adapter_version_chk
    CHECK (provider_adapter_contract_version IS NULL OR provider_adapter_contract_version IN ('1'));

CREATE INDEX provider_attempts_org_workspace_deployment_started_idx
  ON provider_attempts (organization_id, workspace_id, deployment_id, started_at);
