import { graphql } from "./gql";
import type { ViewerQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";

graphql(`
  fragment ViewerFields on Viewer {
    user {
      sessionId
      organizationId
      workspaceId
      userId
      email
      name
      role
    }
    organizationId
    workspaceId
    organizations {
      id
      slug
      name
      role
    }
    workspaces {
      id
      slug
      name
    }
  }
`);

const ViewerDocument = graphql(`
  query Viewer {
    viewer {
      ...ViewerFields
    }
  }
`);

const LoginDocument = graphql(`
  mutation Login($email: String!, $password: String!) {
    login(email: $email, password: $password) {
      ...ViewerFields
    }
  }
`);

const LogoutDocument = graphql(`
  mutation Logout {
    logout
  }
`);

const SwitchOrganizationDocument = graphql(`
  mutation SwitchOrganization($organizationId: ID!) {
    switchOrganization(organizationId: $organizationId) {
      ...ViewerFields
    }
  }
`);

const SwitchWorkspaceDocument = graphql(`
  mutation SwitchWorkspace($workspaceId: ID!) {
    switchWorkspace(workspaceId: $workspaceId) {
      ...ViewerFields
    }
  }
`);

const CreateWorkspaceDocument = graphql(`
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) {
      id
      slug
      name
    }
  }
`);

export type AuthMe = ViewerQuery["viewer"];

export async function fetchMe(): Promise<AuthMe> {
  return (await gqlFetch(ViewerDocument)).viewer;
}

export async function login(email: string, password: string): Promise<AuthMe> {
  return (await gqlFetch(LoginDocument, { email, password })).login;
}

export async function logout() {
  return (await gqlFetch(LogoutDocument)).logout;
}

export async function switchOrganization(organizationId: string): Promise<AuthMe> {
  return (await gqlFetch(SwitchOrganizationDocument, { organizationId })).switchOrganization;
}

export async function switchWorkspace(workspaceId: string): Promise<AuthMe> {
  return (await gqlFetch(SwitchWorkspaceDocument, { workspaceId })).switchWorkspace;
}

export async function createWorkspace(input: { name: string }) {
  return (await gqlFetch(CreateWorkspaceDocument, { input })).createWorkspace;
}
