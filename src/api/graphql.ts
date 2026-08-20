/**
 * ════════════════════════════════════════════════════════════════════════════
 *  api/graphql.ts — GraphQL schema for the fleet
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  A minimal, hand-written GraphQL schema. We deliberately avoid a
 *  build step (no `graphql-codegen`) so that `quilt-fleet` can be
 *  embedded into projects that do not use GraphQL.
 *
 *  Schema
 *  ──────
 *    type Instance  { id, name, tier, endpoint, status, ... }
 *    type Cell      { uri, value, version }
 *    type Query {
 *      instances:  [Instance!]!
 *      instance(name: String!): Instance
 *      cell(uri: String!): Cell
      health:      Health!
 *    }
 *    type Mutation {
 *      subscribe(uri: String!): Subscription!
 *      migrate(uri: String!, target: String!): MigrationResult!
 *    }
 *  ──────────────────────────────────────────────────────────────────────────
 */

import type { FleetManager } from '../fleet';

/** Public GraphQL schema (SDL) — for documentation and for clients
 *  that want to introspect. */
export const GRAPHQL_SDL = /* GraphQL */ `
  type Instance {
    id: ID!
    name: String!
    tier: String!
    endpoint: String!
    status: String!
    load: Float!
    latencyMs: Float!
    region: String
    capabilities: String
  }

  type Cell {
    uri: String!
    value: String
    version: Int
  }

  type Health {
    fleet: String!
    healthy: Int!
    degraded: Int!
    unreachable: Int!
    unknown: Int!
  }

  type Subscription {
    id: ID!
    uri: String!
    instance: String!
  }

  type MigrationResult {
    success: Boolean!
    durationMs: Int!
    attempts: Int!
  }

  type Query {
    instances: [Instance!]!
    instance(name: String!): Instance
    cell(uri: String!): Cell
    health: Health!
  }

  type Mutation {
    subscribe(uri: String!): Subscription!
    migrate(uri: String!, target: String!): MigrationResult!
  }
`;

/** Build a runtime resolver object from a FleetManager. */
export function createGraphQLResolvers(fleet: FleetManager) {
  return {
    Query: {
      instances: () => fleet.registry.all(),
      instance:  (_: unknown, args: { name: string }) =>
        fleet.registry.byInstanceName(args.name),
      cell: async (_: unknown, args: { uri: string }) => {
        const v = await fleet.query(args.uri);
        return { uri: args.uri, value: v === null ? null : JSON.stringify(v), version: null };
      },
      health: () => fleet.health.totals(),
    },
    Mutation: {
      subscribe: async (_: unknown, args: { uri: string }) => {
        const sub = await fleet.subscribe(args.uri);
        return { id: sub.id, uri: sub.uri, instance: sub.instanceName };
      },
      migrate: async (_: unknown, args: { uri: string; target: string }) => {
        const r = await fleet.migrate(args.uri, args.target);
        return { success: r.success, durationMs: r.durationMs, attempts: r.attempts };
      },
    },
  };
}

/** Create a GraphQL schema object that an `apollo-server` / `graphql-http`
 *  server can use. We don't import `graphql` here to keep the
 *  optional dep clean; instead, callers can run
 *  `makeExecutableSchema({ typeDefs, resolvers })` from `graphql-tools`. */
export function createGraphQLSchema(fleet: FleetManager) {
  return {
    typeDefs: GRAPHQL_SDL,
    resolvers: createGraphQLResolvers(fleet),
  };
}
