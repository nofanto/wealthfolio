import {
  ImportMappingData,
  ActivityImport,
  ImportFormat,
  ActivityType,
  CsvRowData,
  ImportValidationResult,
} from "@/lib/types";
import { importActivitySchema } from "@/lib/schemas";
import { tryParseDate } from "@/lib/utils";
import { logger } from "@/adapters";
import { SUBTYPE_DISPLAY_NAMES } from "@/lib/constants";
import { canonicalizeActivitySubtype, isCashSymbol } from "@/lib/activity-utils";
import { looksLikeOccSymbol, normalizeOptionSymbol } from "@/lib/occ-symbol";
import { looksLikeIsin } from "@/lib/isin";
import { findMappedActivityType } from "./activity-type-mapping";
import { normalizeInstrumentType, splitInstrumentPrefixedSymbol } from "./instrument-type";

// Ticker symbol validation regex (full symbol bounded to 100 chars via the leading lookahead)
const tickerRegex = /^(?=.{1,100}$)(CASH:[A-Z]{3}|[A-Z0-9_]+([.-][A-Z0-9_]+){0,2})$/;

// CUSIP: 9 alphanumeric chars ending in a digit
const cusipRegex = /^[A-Z0-9]{8}\d$/;

// Helper to validate ticker symbol format
export function validateTickerSymbol(symbol: string): boolean {
  const { symbol: strippedSymbol } = splitInstrumentPrefixedSymbol(symbol);
  const s = (strippedSymbol || "").trim();
  const upper = s.toUpperCase();
  if (!s) return false;
  return (
    tickerRegex.test(upper) ||
    looksLikeOccSymbol(s) ||
    normalizeOptionSymbol(s) !== null ||
    looksLikeIsin(s) ||
    cusipRegex.test(upper)
  );
}

// Re-export shared activity type mapping utilities
export { findMappedActivityType };

// Build reverse lookup from display names to subtype codes
const DISPLAY_NAME_TO_SUBTYPE: Record<string, string> = {};
for (const [code, displayName] of Object.entries(SUBTYPE_DISPLAY_NAMES)) {
  DISPLAY_NAME_TO_SUBTYPE[displayName.toUpperCase()] = code;
}

/**
 * Normalizes a subtype value to match the expected format.
 * Handles variations like "drip" -> "DRIP", "Dividend Reinvested" -> "DRIP"
 */
function normalizeSubtype(rawSubtype: string): string | undefined {
  if (!rawSubtype) return undefined;

  const trimmed = rawSubtype.trim();
  if (!trimmed) return undefined;

  const upper = trimmed.toUpperCase();

  // Check if it's already a valid subtype code
  if (SUBTYPE_DISPLAY_NAMES[upper]) {
    return upper;
  }

  // Check if it matches a display name
  if (DISPLAY_NAME_TO_SUBTYPE[upper]) {
    return DISPLAY_NAME_TO_SUBTYPE[upper];
  }

  // Try with underscores replaced by spaces and vice versa
  const withSpaces = upper.replace(/_/g, " ");
  if (DISPLAY_NAME_TO_SUBTYPE[withSpaces]) {
    return DISPLAY_NAME_TO_SUBTYPE[withSpaces];
  }

  const withUnderscores = upper.replace(/ /g, "_");
  if (SUBTYPE_DISPLAY_NAMES[withUnderscores]) {
    return withUnderscores;
  }

  // Preserve unknown provider labels as metadata. Canonicalization only applies
  // to known subtype codes, display names, and activity-specific aliases.
  return trimmed;
}

/**
 * Returns the subtype as metadata. Calculation paths only honor known valid
 * type/subtype pairs, so import should not discard broker/provider labels here.
 */
function validateSubtypeForActivityType(
  subtype: string | undefined,
  activityType: ActivityType | undefined,
): string | undefined {
  if (!subtype || !activityType) return undefined;

  if (subtype.toUpperCase() === activityType) return undefined;

  return canonicalizeActivitySubtype(activityType, subtype);
}

/**
 * Normalizes and cleans numeric values from CSV data
 * Handles currency symbols, commas, spaces, and other formatting characters
 *
 * @param value The raw string value from CSV
 * @returns Cleaned numeric value or undefined if invalid
 */
export function normalizeNumericValue(value: string | undefined): number | undefined {
  if (!value || typeof value !== "string") {
    return undefined;
  }

  // Trim whitespace
  let cleaned = value.trim();

  // Handle empty strings
  if (cleaned === "" || cleaned === "-" || cleaned === "N/A" || cleaned.toLowerCase() === "null") {
    return undefined;
  }

  // Remove common currency symbols and formatting
  cleaned = cleaned
    .replace(/[$£€¥₹₦₹₽¢]/g, "") // Remove currency symbols
    .replace(/[,\s]/g, "") // Remove commas and spaces
    .replace(/[()]/g, "") // Remove parentheses (sometimes used for negative values)
    .trim();

  // Handle empty string after cleaning
  if (cleaned === "") {
    return undefined;
  }

  // Parse as float
  const parsed = parseFloat(cleaned);

  // Return undefined if parsing resulted in NaN
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Safely parses a numeric value and returns its absolute value
 * Uses normalization to handle currency symbols and formatting
 *
 * @param value The raw string value from CSV
 * @returns Absolute numeric value or undefined if invalid
 */
export function parseAndAbsoluteValue(value: string | undefined): number | undefined {
  const normalized = normalizeNumericValue(value);
  return normalized !== undefined ? Math.abs(normalized) : undefined;
}

// Use the importValidationResult from types.ts
export type ValidationResult = ImportValidationResult;

/**
 * Calculates the amount for cash activities based on quantity and unit price
 * Priority:
 * 1. If both quantity and unit price are > 0, use their product
 * 2. If only unit price is > 0, use unit price
 * 3. Otherwise, use quantity
 *
 * Note: Uses absolute values to handle brokers that use negative values to indicate transaction direction
 *
 * @param quantity The quantity value, if available
 * @param unitPrice The unit price value, if available
 * @returns The calculated amount (always positive)
 */
export function calculateCashActivityAmount(
  quantity: number | undefined,
  unitPrice: number | undefined,
): number | undefined {
  // Type guard - convert undefined to 0 for safe calculations and ensure absolute values
  const safeQuantity = quantity !== undefined && !isNaN(quantity) ? Math.abs(quantity) : 0;
  const safeUnitPrice = unitPrice !== undefined && !isNaN(unitPrice) ? Math.abs(unitPrice) : 0;

  // Both quantity and unit price are positive
  if (safeQuantity > 0 && safeUnitPrice > 0) {
    return safeQuantity * safeUnitPrice;
  }

  // Only unit price is positive
  if (safeUnitPrice > 0) {
    return safeUnitPrice;
  }

  // Some cash exports place the monetary value in quantity.
  return safeQuantity > 0 ? safeQuantity : undefined;
}

/** Convert decimal-like schema values (string | number | null | undefined) to number | undefined */
function toNum(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  return isNaN(n) ? undefined : n;
}

// Define types for the calculation functions
type SymbolCalculator = (
  activity: Partial<ActivityImport>,
  accountCurrency: string,
) => string | undefined;
type AmountCalculator = (activity: Partial<ActivityImport>) => number | undefined;
type FeeCalculator = (activity: Partial<ActivityImport>) => number | undefined;

// Define the configuration structure
interface ActivityLogicConfig {
  calculateSymbol: SymbolCalculator;
  calculateAmount: AmountCalculator;
  calculateFee: FeeCalculator;
}

function suppliedAmount(activity: Partial<ActivityImport>): number | undefined {
  const amount = toNum(activity.amount);
  return amount === undefined ? undefined : Math.abs(amount);
}

function derivedCashAmount(
  activity: Partial<ActivityImport>,
  direction: "in" | "out",
): number | undefined {
  const explicit = suppliedAmount(activity);
  if (explicit !== undefined) return explicit;

  const gross = calculateCashActivityAmount(toNum(activity.quantity), toNum(activity.unitPrice));
  if (gross === undefined) return undefined;
  const charges = Math.abs(toNum(activity.fee) ?? 0) + Math.abs(toNum(activity.tax) ?? 0);
  const derived = direction === "in" ? gross - charges : gross + charges;
  return derived > 0 ? derived : undefined;
}

function isImportedCashTransfer(activity: Partial<ActivityImport>): boolean {
  const symbol = activity.symbol?.trim();
  return !symbol || symbol.toUpperCase() === "CASH" || isCashSymbol(symbol);
}

// Create the configuration map
const activityLogicMap: Partial<Record<ActivityType, ActivityLogicConfig>> = {
  [ActivityType.BUY]: {
    calculateSymbol: (activity) => activity.symbol, // Keep original symbol
    calculateAmount: (activity) => {
      const amt = toNum(activity.amount);
      return amt !== undefined ? Math.abs(amt) : undefined;
    },
    calculateFee: (activity) => {
      const f = toNum(activity.fee);
      return f ? Math.abs(f) : 0;
    },
  },
  [ActivityType.SELL]: {
    calculateSymbol: (activity) => activity.symbol,
    calculateAmount: (activity) => {
      const amt = toNum(activity.amount);
      return amt !== undefined ? Math.abs(amt) : undefined;
    },
    calculateFee: (activity) => {
      const f = toNum(activity.fee);
      return f ? Math.abs(f) : 0;
    },
  },
  [ActivityType.DEPOSIT]: {
    calculateSymbol: () => "",
    calculateAmount: (activity) => derivedCashAmount(activity, "in"),
    calculateFee: (activity) => {
      const f = toNum(activity.fee);
      return f ? Math.abs(f) : 0;
    },
  },
  [ActivityType.WITHDRAWAL]: {
    calculateSymbol: () => "",
    calculateAmount: (activity) => derivedCashAmount(activity, "out"),
    calculateFee: (activity) => {
      const f = toNum(activity.fee);
      return f ? Math.abs(f) : 0;
    },
  },
  [ActivityType.INTEREST]: {
    calculateSymbol: (a) => a.symbol || "",
    calculateAmount: (activity) => derivedCashAmount(activity, "in"),
    calculateFee: (activity) => {
      const f = toNum(activity.fee);
      return f ? Math.abs(f) : 0;
    },
  },
  [ActivityType.DIVIDEND]: {
    calculateSymbol: (activity) => activity.symbol, // Usually associated with a stock
    calculateAmount: (activity) => derivedCashAmount(activity, "in"),
    calculateFee: (activity) => {
      const f = toNum(activity.fee);
      return f ? Math.abs(f) : 0;
    },
  },
  [ActivityType.FEE]: {
    calculateSymbol: () => "",
    calculateAmount: (activity) => {
      const charge = Math.abs(toNum(activity.fee) ?? 0);
      return suppliedAmount(activity) ?? (charge > 0 ? charge : undefined);
    },
    calculateFee: () => 0,
  },
  [ActivityType.TAX]: {
    calculateSymbol: () => "",
    calculateAmount: (activity) => {
      const tax = Math.abs(toNum(activity.tax) ?? 0);
      const fee = Math.abs(toNum(activity.fee) ?? 0);
      const charge = tax > 0 ? tax : fee;
      return suppliedAmount(activity) ?? (charge > 0 ? charge : undefined);
    },
    calculateFee: () => 0,
  },
  [ActivityType.TRANSFER_IN]: {
    calculateSymbol: (a) => a.symbol || "",
    calculateAmount: (activity) => {
      if (!isImportedCashTransfer(activity)) return suppliedAmount(activity);
      return derivedCashAmount(activity, "in");
    },
    calculateFee: (activity) => {
      const f = toNum(activity.fee);
      return f ? Math.abs(f) : 0;
    },
  },
  [ActivityType.TRANSFER_OUT]: {
    calculateSymbol: (a) => a.symbol || "",
    calculateAmount: (activity) => {
      if (!isImportedCashTransfer(activity)) return suppliedAmount(activity);
      return derivedCashAmount(activity, "out");
    },
    calculateFee: (activity) => {
      const f = toNum(activity.fee);
      return f ? Math.abs(f) : 0;
    },
  },
  [ActivityType.SPLIT]: {
    calculateSymbol: (activity) => activity.symbol,
    calculateAmount: (activity) => {
      const amt = toNum(activity.amount);
      return typeof amt === "number" && amt > 0 ? amt : undefined;
    },
    calculateFee: () => 0, // SPLIT typically has no fee
  },
  [ActivityType.CREDIT]: {
    calculateSymbol: () => "",
    calculateAmount: (activity) => derivedCashAmount(activity, "in"),
    calculateFee: (activity) => {
      const f = toNum(activity.fee);
      return f ? Math.abs(f) : 0;
    },
  },
};

// Default logic if type-specific logic isn't found
const defaultLogic: ActivityLogicConfig = {
  calculateSymbol: (activity) => activity.symbol,
  calculateAmount: (activity) => {
    const amt = toNum(activity.amount);
    return amt !== undefined ? Math.abs(amt) : undefined;
  },
  calculateFee: (activity) => {
    const f = toNum(activity.fee);
    return f ? Math.abs(f) : 0;
  },
};

// Helper function to transform a CSV row into an Activity object
function transformRowToActivity(
  row: CsvRowData,
  mapping: ImportMappingData,
  accountId: string,
  accountCurrency: string,
): Partial<ActivityImport> {
  const activity: Partial<ActivityImport> = { accountId, isDraft: true, isValid: false };

  // Helper to get mapped value (supports fallback column arrays)
  const getMappedValue = (field: ImportFormat): string | undefined => {
    const headerName = mapping.fieldMappings[field];
    if (!headerName) return undefined;
    if (Array.isArray(headerName)) {
      for (const h of headerName) {
        const value = row[h];
        const trimmed = typeof value === "string" ? value.trim() : undefined;
        if (trimmed) return trimmed;
      }
      return undefined;
    }
    const value = row[headerName];
    return typeof value === "string" ? value.trim() : undefined;
  };

  // Handle account ID mapping
  const csvAccountId = getMappedValue(ImportFormat.ACCOUNT);
  activity.accountId =
    csvAccountId && mapping.accountMappings?.[csvAccountId.trim()]
      ? mapping.accountMappings[csvAccountId.trim()] // Use mapped account ID if available
      : accountId; // Fall back to default account ID

  // 1. Map Raw Values & Basic Parsing
  const rawDate = getMappedValue(ImportFormat.DATE);
  activity.date = rawDate ? tryParseDate(rawDate)?.toISOString() : undefined;
  activity.symbol = getMappedValue(ImportFormat.SYMBOL);
  const rawInstrumentType = getMappedValue(ImportFormat.INSTRUMENT_TYPE);
  activity.instrumentType = normalizeInstrumentType(rawInstrumentType);
  const csvActivityType = getMappedValue(ImportFormat.ACTIVITY_TYPE);
  // Store raw parsed values temporarily before applying logic
  // Use absolute values for numeric fields to handle brokers that use negative values for direction
  // Also normalize values to handle currency symbols and formatting
  const rawQuantity = parseAndAbsoluteValue(getMappedValue(ImportFormat.QUANTITY));
  const rawUnitPrice = parseAndAbsoluteValue(getMappedValue(ImportFormat.UNIT_PRICE));
  const rawFee = parseAndAbsoluteValue(getMappedValue(ImportFormat.FEE));
  const rawTax = parseAndAbsoluteValue(getMappedValue(ImportFormat.TAX));
  const rawAmount = parseAndAbsoluteValue(getMappedValue(ImportFormat.AMOUNT));

  // Assign potentially NaN values first, they will be cleaned up later
  activity.quantity = rawQuantity;
  activity.unitPrice = rawUnitPrice;
  activity.currency = getMappedValue(ImportFormat.CURRENCY) || accountCurrency;
  activity.fee = rawFee;
  activity.tax = rawTax;
  activity.amount = rawAmount;
  activity.lineNumber = parseInt(row.lineNumber);
  activity.comment = getMappedValue(ImportFormat.COMMENT)?.trim() || undefined;

  // Extract optional fields: fxRate, subtype (subtype will be validated after activity type is determined)
  activity.fxRate = parseAndAbsoluteValue(getMappedValue(ImportFormat.FX_RATE));
  if (activity.fxRate !== undefined && isNaN(activity.fxRate)) activity.fxRate = undefined;
  const rawSubtype = getMappedValue(ImportFormat.SUBTYPE);
  const normalizedSubtype = normalizeSubtype(rawSubtype || "");

  // Apply Symbol Mapping BEFORE determining activity type logic
  if (activity.symbol) {
    const symbolKey = activity.symbol.trim();
    activity.symbol = mapping.symbolMappings[symbolKey] || symbolKey;
  }

  // Support typed symbol format (e.g. bond:US037833DU14)
  const symbolWithType = splitInstrumentPrefixedSymbol(activity.symbol);
  activity.symbol = symbolWithType.symbol;
  activity.instrumentType = activity.instrumentType || symbolWithType.instrumentType;

  // 2. Determine Activity Type
  if (csvActivityType) {
    activity.activityType =
      findMappedActivityType(csvActivityType, mapping.activityMappings) ?? activity.activityType;
  }

  // Validate subtype against allowed subtypes for the determined activity type
  activity.subtype = validateSubtypeForActivityType(normalizedSubtype, activity.activityType);

  // 3. Apply Logic from Configuration
  const logic = activity.activityType
    ? (activityLogicMap[activity.activityType] ?? defaultLogic)
    : defaultLogic;

  // Calculate final symbol, amount, and fee using the config
  // Pass a *copy* of the activity so far to avoid premature mutation within calc functions
  const currentActivityState = { ...activity };
  activity.symbol = logic.calculateSymbol(currentActivityState, accountCurrency);
  activity.amount = logic.calculateAmount(currentActivityState);
  activity.fee = logic.calculateFee(currentActivityState);
  if (activity.activityType === ActivityType.TAX) {
    activity.tax = 0;
  }

  // 4. Final Cleanup & Defaulting
  // Handle NaN values resulting from calculations or initial parsing
  if (activity.quantity !== undefined && isNaN(activity.quantity)) activity.quantity = undefined;
  if (activity.unitPrice !== undefined && isNaN(activity.unitPrice)) activity.unitPrice = undefined;
  if (activity.fee !== undefined && isNaN(activity.fee)) activity.fee = 0; // Ensure fee is 0 if NaN
  if (activity.tax !== undefined && isNaN(activity.tax)) activity.tax = 0;
  if (activity.amount !== undefined && isNaN(activity.amount)) activity.amount = undefined;

  if (activity.activityType === ActivityType.SPLIT) {
    activity.quantity = undefined;
    activity.unitPrice = undefined;
  } else if (activity.amount !== undefined && !isNaN(activity.amount)) {
    // If amount is validly set (not undefined and not NaN), default quantity/unitPrice to 0 if they are undefined/NaN
    if (activity.quantity === undefined || isNaN(activity.quantity)) {
      activity.quantity = 0;
    }
    if (activity.unitPrice === undefined || isNaN(activity.unitPrice)) {
      activity.unitPrice = 0;
    }
  } else {
    // If amount is still undefined/NaN, ensure quantity/unitPrice remain undefined if they started as NaN
    if (activity.quantity !== undefined && isNaN(activity.quantity)) activity.quantity = undefined;
    if (activity.unitPrice !== undefined && isNaN(activity.unitPrice))
      activity.unitPrice = undefined;
  }

  // Ensure fee is always a number (default to 0 if undefined)
  activity.fee = activity.fee ?? 0;
  activity.tax = activity.tax ?? 0;

  return activity;
}

/**
 * Validates CSV data against import mapping rules and business logic
 *
 * @param data The parsed CSV data to validate
 * @param mapping The mapping configuration for interpreting CSV data
 * @param accountId The account ID to associate with the activities
 * @returns Validation results with valid activities and error information
 */
export function validateActivityImport(
  data: CsvRowData[],
  mapping: ImportMappingData,
  accountId: string,
  accountCurrency: string,
): ValidationResult {
  if (!data || data.length === 0) {
    throw new Error("CSV data is required and must have at least one row");
  }

  if (!accountId) {
    throw new Error("Account ID is required for validation");
  }

  try {
    // Initialize results
    const allActivities: ActivityImport[] = [];

    // Process each data row
    data.forEach((row) => {
      try {
        // Transform row to activity object
        const transformedActivity = transformRowToActivity(
          row,
          mapping,
          accountId,
          accountCurrency,
        );

        // Validate against schema (type safety, required fields, business rules)
        const schemaValidation = importActivitySchema.safeParse(transformedActivity);

        if (schemaValidation.success) {
          const activity = schemaValidation.data;
          activity.accountId = transformedActivity.accountId ?? accountId;
          activity.isValid = true;
          allActivities.push(activity);
        } else {
          // Collect schema validation errors
          const allValidationErrors: Record<string, string[]> = {};

          schemaValidation.error.issues.forEach((issue) => {
            const field = issue.path.join(".") || "general";
            if (!allValidationErrors[field]) {
              allValidationErrors[field] = [];
            }
            allValidationErrors[field].push(issue.message);
          });

          // Create activity with schema validation errors
          const activity = {
            ...transformedActivity,
            isValid: false,
            errors: allValidationErrors,
          } as ActivityImport;

          allActivities.push(activity);
        }
      } catch (error) {
        // Handle unexpected errors
        logger.error(`Error processing row to activity: ${String(error)}`);
        const lineNumber = parseInt(row.lineNumber);

        // Create a minimal activity with error information
        const activity = {
          accountId,
          isDraft: true,
          isValid: false,
          lineNumber,
          errors: {
            general: ["Failed to process row data"],
          },
        } as unknown as ActivityImport;

        allActivities.push(activity);
      }
    });

    // Calculate summary metrics
    const validationSummary = {
      totalRows: data.length,
      validCount: allActivities.filter((a) => a.isValid).length,
      invalidCount: allActivities.filter((a) => !a.isValid).length,
    };

    return {
      activities: allActivities,
      validationSummary,
    };
  } catch (error) {
    logger.error(`Validation process error: ${String(error)}`);
    throw error;
  }
}
