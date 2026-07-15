import { builder } from "./builder.js";
import "./types/core.js";
import "./types/viewer.js";
import "./types/analytics.js";
import "./types/requests.js";
import "./types/prompts.js";
import "./types/sessions.js";
import "./types/users.js";
import "./types/routing.js";
import "./types/invitations.js";
import "./types/search.js";
import "./types/settings.js";
import "./types/harness.js";
import "./types/gatewayConfig.js";
import "./queries.js";
import "./mutations.js";
import "./gatewayConfig.js";

export const schema = builder.toSchema();
