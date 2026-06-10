import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  schema: "../proxy/schema.graphql",
  documents: ["src/**/*.ts", "src/**/*.tsx", "!src/gql/**"],
  ignoreNoDocuments: true,
  generates: {
    "./src/gql/": {
      preset: "client",
      presetConfig: {
        fragmentMasking: false
      },
      config: {
        documentMode: "string",
        enumsAsTypes: true,
        scalars: {
          JSON: "unknown"
        }
      }
    }
  }
};

export default config;
