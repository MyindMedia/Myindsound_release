/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as crons from "../crons.js";
import type * as diagnostics from "../diagnostics.js";
import type * as downloadLogic from "../downloadLogic.js";
import type * as downloads from "../downloads.js";
import type * as entitlements from "../entitlements.js";
import type * as fulfilment from "../fulfilment.js";
import type * as ghl from "../ghl.js";
import type * as ghlLogic from "../ghlLogic.js";
import type * as http from "../http.js";
import type * as leads from "../leads.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_clerkApi from "../lib/clerkApi.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_ghlApi from "../lib/ghlApi.js";
import type * as lib_storage from "../lib/storage.js";
import type * as orders from "../orders.js";
import type * as payments from "../payments.js";
import type * as plays from "../plays.js";
import type * as privacy from "../privacy.js";
import type * as products from "../products.js";
import type * as seed from "../seed.js";
import type * as stripeLogic from "../stripeLogic.js";
import type * as tracks from "../tracks.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  crons: typeof crons;
  diagnostics: typeof diagnostics;
  downloadLogic: typeof downloadLogic;
  downloads: typeof downloads;
  entitlements: typeof entitlements;
  fulfilment: typeof fulfilment;
  ghl: typeof ghl;
  ghlLogic: typeof ghlLogic;
  http: typeof http;
  leads: typeof leads;
  "lib/auth": typeof lib_auth;
  "lib/clerkApi": typeof lib_clerkApi;
  "lib/errors": typeof lib_errors;
  "lib/ghlApi": typeof lib_ghlApi;
  "lib/storage": typeof lib_storage;
  orders: typeof orders;
  payments: typeof payments;
  plays: typeof plays;
  privacy: typeof privacy;
  products: typeof products;
  seed: typeof seed;
  stripeLogic: typeof stripeLogic;
  tracks: typeof tracks;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
