import {
  isAssetBackedIncomeSubtype,
  isAssetIdentityRequired,
  isCashActivity,
  isCashTransfer,
  getContractMultiplier,
  isIncomeActivity,
  isSecuritiesTransfer,
  resolveActivityCash,
} from "@/lib/activity-utils";
import { buildAssetResolutionInput, normalizeOptionalString } from "@/lib/asset-resolution-input";
import {
  ActivityType,
  DECIMAL_PRECISION,
  SUBTYPES_BY_ACTIVITY_TYPE,
} from "@/lib/constants";
import type { Account } from "@/lib/types";
import {
  normalizeDecimalString,
  parseLocalDateTime,
  roundDecimal,
} from "@/lib/utils";
import type {
  ActivityCreatePayload,
  ActivityUpdatePayload,
  CurrencyResolutionOptions,
  LocalTransaction,
  SavePayloadResult,
  TransactionUpdateParams,
} from "./types";
import { generateTempActivityId } from "./use-activity-grid-state";

/**
 * Set of numeric field names for value comparison
 */
const NUMERIC_FIELDS = new Set(["quantity", "unitPrice", "amount", "fee", "tax", "fxRate"]);

const isTransferActivity = (activityType: string | undefined): boolean => {
  return activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT;
};

const isSubtypeAllowedForActivityType = (
  activityType: string | undefined,
  subtype: string | null | undefined,
): boolean => {
  if (!subtype) {
    return true;
  }
  return (SUBTYPES_BY_ACTIVITY_TYPE[activityType ?? ""] ?? []).includes(subtype);
};

const isAlwaysCashActivity = (
  activityType: string | undefined,
  subtype?: string | null,
): boolean => {
  if (!activityType) {
    return false;
  }
  return (
    isCashActivity(activityType) &&
    !isTransferActivity(activityType) &&
    !isAssetBackedIncomeSubtype(activityType, subtype)
  );
};

/**
 * Converts a value to a string for API payloads.
 * Returns null for explicit null (clear), undefined for missing/invalid values.
 */
function toDecimalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return null;
  const normalized = normalizeDecimalString(value);
  return normalized ?? undefined;
}

/**
 * Converts a value to a timestamp for date comparison
 */
function toTimestamp(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  return null;
}

/**
 * Compares two values for equality, handling numeric and date comparisons specially
 */
export function valuesAreEqual(field: string, prevValue: unknown, nextValue: unknown): boolean {
  if (NUMERIC_FIELDS.has(field)) {
    const normalizeForCompare = (value: unknown): string | null => {
      if (value == null) return null;
      if (typeof value === "string" && value.trim() === "") return null;
      return normalizeDecimalString(value);
    };
    return normalizeForCompare(prevValue) === normalizeForCompare(nextValue);
  }
  // Handle date field comparison by timestamp
  if (field === "date") {
    const prevTime = toTimestamp(prevValue);
    const nextTime = toTimestamp(nextValue);
    if (prevTime === null && nextTime === null) return true;
    if (prevTime === null || nextTime === null) return false;
    return prevTime === nextTime;
  }
  return Object.is(prevValue, nextValue);
}

/**
 * Resolves the asset ID for a transaction.
 * For cash activities, returns undefined - backend will generate CASH:{currency}.
 * For market activities, returns the existing assetId if present.
 *
 * NOTE: This function no longer generates CASH:{currency} IDs.
 * The backend is now the sole generator of canonical asset IDs.
 */
export function resolveAssetIdForTransaction(
  transaction: LocalTransaction,
  _fallbackCurrency: string,
): string | undefined {
  // For cash activities, don't return an assetId - backend will generate CASH:{currency}
  if (isAlwaysCashActivity(transaction.activityType, transaction.subtype)) {
    return undefined;
  }

  // For market activities, return the existing assetId if present
  const existingAssetId = transaction.assetId?.trim() || transaction.assetSymbol?.trim();
  if (existingAssetId) {
    return existingAssetId;
  }

  return undefined;
}

/**
 * Creates a new draft transaction with default values.
 * Note: needsReview is set to false because needsReview=true is reserved for
 * activities created by the sync service that need user review.
 * The isNew flag is used to track locally created rows.
 */
export function createDraftTransaction(
  accounts: Account[],
  fallbackCurrency: string,
): LocalTransaction {
  const defaultAccount = accounts.find((account) => account.isActive) ?? accounts[0];
  const now = new Date();

  return {
    id: generateTempActivityId(),
    activityType: ActivityType.BUY,
    // Use ISO string to match server data format for consistent sorting
    date: now.toISOString() as unknown as Date,
    quantity: null,
    unitPrice: null,
    amount: null,
    amountMode: "calculated",
    fee: null,
    tax: null,
    currency: defaultAccount?.currency ?? fallbackCurrency,
    needsReview: false,
    comment: "",
    createdAt: now,
    assetId: "",
    updatedAt: now,
    accountId: defaultAccount?.id ?? "",
    accountName: defaultAccount?.name ?? "",
    accountCurrency: defaultAccount?.currency ?? fallbackCurrency,
    assetSymbol: "",
    assetName: "",
    assetQuoteMode: undefined,
    subRows: undefined,
    isNew: true,
  };
}

/**
 * Applies cash activity defaults for display purposes.
 * NOTE: Does NOT set assetId - backend will generate CASH:{currency} on save.
 * Just sets display-friendly values for the grid.
 * Returns a new transaction object with the defaults applied (immutable)
 */
function applyCashDefaults(
  transaction: LocalTransaction,
  resolveTransactionCurrency: TransactionUpdateParams["resolveTransactionCurrency"],
  fallbackCurrency: string,
): LocalTransaction {
  if (!isAlwaysCashActivity(transaction.activityType, transaction.subtype)) {
    return transaction;
  }
  const derivedCurrency = resolveTransactionCurrency(transaction) ?? fallbackCurrency;
  // Display "CASH" as symbol for UI clarity, but don't set assetId
  // Backend will generate the canonical CASH:{currency} ID
  return {
    ...transaction,
    assetSymbol: "CASH",
    // Clear assetId - backend generates the canonical ID
    assetId: "",
    currency: derivedCurrency.toUpperCase(),
    quantity: null,
    unitPrice: null,
  };
}

/**
 * Applies split activity defaults
 * Returns a new transaction object with the defaults applied (immutable)
 */
function applySplitDefaults(transaction: LocalTransaction): LocalTransaction {
  if (transaction.activityType !== ActivityType.SPLIT) {
    return transaction;
  }
  return {
    ...transaction,
    quantity: null,
    unitPrice: null,
  };
}

export function applyCalculatedTradeTotal(transaction: LocalTransaction): LocalTransaction {
  const isTrade =
    transaction.activityType === ActivityType.BUY || transaction.activityType === ActivityType.SELL;
  const isAssetBackedIncome = isAssetBackedIncomeSubtype(
    transaction.activityType,
    transaction.subtype,
  );
  if ((!isTrade && !isAssetBackedIncome) || transaction.amountMode !== "calculated") {
    return transaction;
  }

  const quantity = transaction.quantity != null ? Number(transaction.quantity) : NaN;
  const unitPrice = transaction.unitPrice != null ? Number(transaction.unitPrice) : NaN;
  if (!(quantity > 0) || !(unitPrice > 0)) {
    return { ...transaction, amount: null };
  }

  const gross = quantity * unitPrice * getContractMultiplier(transaction);
  const charges = Number(transaction.fee || 0) + Number(transaction.tax || 0);
  const total = transaction.activityType === ActivityType.BUY ? gross + charges : gross - charges;
  const rounded = total > 0 ? roundDecimal(total, DECIMAL_PRECISION) : undefined;

  return {
    ...transaction,
    amount: rounded === undefined ? null : (normalizeDecimalString(rounded) ?? null),
  };
}

/**
 * Applies an update to a transaction field with proper type handling and side effects
 */
export function applyTransactionUpdate(params: TransactionUpdateParams): LocalTransaction {
  const {
    transaction,
    field,
    value,
    accountLookup,
    assetCurrencyLookup,
    assetMultiplierLookup,
    fallbackCurrency,
    resolveTransactionCurrency,
  } = params;

  let updated: LocalTransaction = { ...transaction };
  const normalizedDecimalOrNull = (value: unknown): string | null => {
    if (value == null || value === "") return null;
    return normalizeDecimalString(value) ?? null;
  };

  if (field === "date") {
    if (typeof value === "string") {
      updated = { ...updated, date: parseLocalDateTime(value) };
    } else if (value instanceof Date) {
      updated = { ...updated, date: value };
    }
  } else if (field === "quantity") {
    const newQty = normalizedDecimalOrNull(value);
    updated = { ...updated, quantity: newQty };
    updated = applySplitDefaults(updated);
  } else if (field === "unitPrice") {
    const newUnitPrice = normalizedDecimalOrNull(value);
    updated = { ...updated, unitPrice: newUnitPrice };
    if (
      newUnitPrice != null &&
      (isAlwaysCashActivity(updated.activityType, updated.subtype) ||
        (isIncomeActivity(updated.activityType) &&
          !isAssetBackedIncomeSubtype(updated.activityType, updated.subtype)))
    ) {
      updated = { ...updated, amount: newUnitPrice };
    }
    updated = applySplitDefaults(updated);
  } else if (field === "amount") {
    if (value == null || value === "") {
      updated = { ...updated, amount: null, amountMode: "calculated" };
    } else {
      updated = {
        ...updated,
        amount: normalizeDecimalString(value) ?? null,
        amountMode: "custom",
      };
    }
  } else if (field === "fee") {
    updated = { ...updated, fee: normalizedDecimalOrNull(value) };
  } else if (field === "tax") {
    updated = { ...updated, tax: normalizedDecimalOrNull(value) };
  } else if (field === "assetSymbol") {
    const upper = (typeof value === "string" ? value : "").trim().toUpperCase();
    // Only update assetSymbol, NOT assetId
    // For new activities, backend generates canonical assetId from symbol + exchangeMic
    // For existing activities, assetId is preserved from the original data
    updated = {
      ...updated,
      assetSymbol: upper,
      contractMultiplier:
        assetMultiplierLookup?.get(upper) ?? updated.contractMultiplier,
    };

    // Auto-fill currency only if not already set (e.g., by handleSymbolSelect
    // which sets the correct currency from search result / quote resolution).
    // This avoids overriding minor currencies like GBp with the account's GBP.
    if (!updated.currency) {
      if (updated.accountCurrency) {
        updated = { ...updated, currency: updated.accountCurrency };
      } else {
        const assetKey = upper;
        const assetCurrency = assetCurrencyLookup.get(assetKey);
        if (assetCurrency) {
          updated = { ...updated, currency: assetCurrency };
        } else {
          updated = { ...updated, currency: fallbackCurrency };
        }
      }
    }
  } else if (field === "activityType") {
    const nextActivityType = value as ActivityType;
    const wasCalculatedAmountType =
      updated.activityType === ActivityType.BUY ||
      updated.activityType === ActivityType.SELL ||
      isAssetBackedIncomeSubtype(updated.activityType, updated.subtype);
    const wasAssetBacked = isAssetBackedIncomeSubtype(updated.activityType, updated.subtype);
    const nextSubtype = isSubtypeAllowedForActivityType(nextActivityType, updated.subtype)
      ? updated.subtype
      : undefined;

    updated = { ...updated, activityType: nextActivityType, subtype: nextSubtype };
    const isCalculatedAmountType =
      nextActivityType === ActivityType.BUY ||
      nextActivityType === ActivityType.SELL ||
      isAssetBackedIncomeSubtype(nextActivityType, nextSubtype);
    if (updated.amountMode === "calculated" && wasCalculatedAmountType && !isCalculatedAmountType) {
      updated = { ...updated, amount: null };
    }
    if (wasAssetBacked && !isAssetBackedIncomeSubtype(nextActivityType, nextSubtype)) {
      updated = { ...updated, quantity: null, unitPrice: null };
    }
    updated = applyCashDefaults(updated, resolveTransactionCurrency, fallbackCurrency);
    updated = applySplitDefaults(updated);
  } else if (field === "accountId") {
    const newAccountId = typeof value === "string" ? value : "";
    updated = { ...updated, accountId: newAccountId };
    const account = accountLookup.get(newAccountId);
    if (account) {
      updated = { ...updated, accountName: account.name, accountCurrency: account.currency };

      // Auto-fill currency: account currency (users enter prices in account currency)
      updated = { ...updated, currency: account.currency };
    }
    updated = applyCashDefaults(updated, resolveTransactionCurrency, fallbackCurrency);
    updated = applySplitDefaults(updated);
  } else if (field === "currency") {
    updated = { ...updated, currency: typeof value === "string" ? value : updated.currency };
    updated = applyCashDefaults(updated, resolveTransactionCurrency, fallbackCurrency);
    updated = applySplitDefaults(updated);
  } else if (field === "comment") {
    updated = { ...updated, comment: typeof value === "string" ? value : "" };
  } else if (field === "fxRate") {
    updated = { ...updated, fxRate: normalizeDecimalString(value) };
  } else if (field === "subtype") {
    const wasAssetBacked = isAssetBackedIncomeSubtype(updated.activityType, updated.subtype);
    const newSubtype = typeof value === "string" && value ? value : undefined;
    updated = { ...updated, subtype: newSubtype };
    if (
      isAssetBackedIncomeSubtype(updated.activityType, newSubtype) &&
      updated.assetSymbol === "CASH"
    ) {
      updated = { ...updated, assetSymbol: "", assetId: "" };
    }
    if (
      !isAssetBackedIncomeSubtype(updated.activityType, newSubtype) &&
      wasAssetBacked
    ) {
      updated = {
        ...updated,
        quantity: null,
        unitPrice: null,
        amount: updated.amountMode === "calculated" ? null : updated.amount,
      };
    }
    updated = applyCashDefaults(updated, resolveTransactionCurrency, fallbackCurrency);
  } else if (field === "isExternal") {
    // Explicit performance boundary stored in metadata.flow.is_external.
    updated = { ...updated, isExternal: Boolean(value) };
  } else if (field === "instrumentType") {
    // Instrument type (EQUITY, OPTION, BOND, etc.) — also set pendingInstrumentType for save payload
    const instrumentType = typeof value === "string" && value ? value : undefined;
    updated = { ...updated, instrumentType, pendingInstrumentType: instrumentType };
  }

  updated = applyCalculatedTradeTotal(updated);
  return { ...updated, updatedAt: new Date() };
}

/**
 * Creates a currency resolution function for a given context.
 * Resolution order:
 * 1. Asset currency (from assetCurrencyLookup or cash asset ID format)
 * 2. Account currency (from transaction.accountCurrency)
 * 3. App base currency (fallbackCurrency)
 */
export function createCurrencyResolver(
  assetCurrencyLookup: Map<string, string>,
  fallbackCurrency: string,
) {
  return (
    transaction: LocalTransaction,
    options: CurrencyResolutionOptions = { includeFallback: true },
  ): string | undefined => {
    // If currency is already set on the transaction, use it
    if (transaction.currency) {
      return transaction.currency;
    }

    // 1. Try to get currency from the asset
    const assetKey = (transaction.assetId ?? transaction.assetSymbol ?? "").trim().toUpperCase();

    let cashCurrency: string | undefined;
    if (assetKey.startsWith("CASH:")) {
      const currency = assetKey.slice("CASH:".length);
      if (/^[A-Z]{3}$/.test(currency)) {
        cashCurrency = currency;
      }
    }
    const assetCurrency = cashCurrency ?? assetCurrencyLookup.get(assetKey);

    if (assetCurrency) {
      return assetCurrency;
    }

    if (options.includeFallback !== false) {
      // 2. Fall back to account currency
      if (transaction.accountCurrency) {
        return transaction.accountCurrency;
      }
      // 3. Fall back to app base currency
      return fallbackCurrency;
    }

    return undefined;
  };
}

/**
 * Builds the save payload from dirty and deleted transactions.
 *
 * Asset identification strategy:
 * - For NEW activities: send asset identity, plus an existing id when selected from search
 * - For EDITING existing: send id-only unless natural identity changed
 * - For CASH activities: don't send asset, backend generates CASH:{currency}
 */
export function buildSavePayload(
  localTransactions: LocalTransaction[],
  dirtyTransactionIds: Set<string>,
  pendingDeleteIds: Set<string>,
  resolveTransactionCurrency: (
    transaction: LocalTransaction,
    options?: CurrencyResolutionOptions,
  ) => string | undefined,
  dirtyCurrencyLookup: Map<string, string>,
  _assetCurrencyLookup: Map<string, string>,
  fallbackCurrency: string,
): SavePayloadResult {
  const creates: ActivityCreatePayload[] = [];
  const updates: ActivityUpdatePayload[] = [];
  const deleteIds = Array.from(pendingDeleteIds);

  const dirtyTransactions = localTransactions.filter((transaction) =>
    dirtyTransactionIds.has(transaction.id),
  );

  for (const transaction of dirtyTransactions) {
    const resolvedCurrency =
      resolveTransactionCurrency(transaction, { includeFallback: false }) ??
      dirtyCurrencyLookup.get(transaction.id);
    const currencyFallback = transaction.accountCurrency ?? fallbackCurrency;
    const isTransfer =
      transaction.activityType === ActivityType.TRANSFER_IN ||
      transaction.activityType === ActivityType.TRANSFER_OUT;
    const supportsBoundary = isTransfer || transaction.activityType === ActivityType.CREDIT;
    const assetSymbol = (transaction.assetSymbol || "").trim();
    const isCash = isTransfer
      ? isCashTransfer(transaction.activityType, assetSymbol) || !assetSymbol
      : isAlwaysCashActivity(transaction.activityType, transaction.subtype);
    // For assets not in our lookup (new assets), send undefined currency to let the backend
    // derive it from the asset and properly register the FX pair if needed.
    // Only use account currency fallback for cash activities where the currency is deterministic.
    const currencyForPayload = resolvedCurrency ?? (isCash ? currencyFallback : undefined);

    const isNew = transaction.isNew === true;

    // Build metadata JSON if an explicit performance boundary is present.
    let metadataJson: string | undefined;
    if (supportsBoundary && transaction.isExternal != null) {
      // Existing updates retain metadata. New manual duplicates carry only the boundary marker.
      const existingMeta =
        !isNew && typeof transaction.metadata === "object" ? transaction.metadata : {};
      const newMeta = {
        ...existingMeta,
        flow: {
          ...(existingMeta?.flow as Record<string, unknown> | undefined),
          is_external: transaction.isExternal,
        },
      };
      metadataJson = JSON.stringify(newMeta);
    }

    // Common payload fields (shared between create and update)
    const fxRate =
      transaction.fxRate === undefined ? undefined : toDecimalString(transaction.fxRate);
    const basePayload = {
      id: transaction.id,
      accountId: transaction.accountId,
      activityType: transaction.activityType,
      activityDate:
        transaction.date instanceof Date
          ? transaction.date.toISOString()
          : new Date(transaction.date).toISOString(),
      // Activity data
      subtype: transaction.subtype ?? undefined,
      quantity: toDecimalString(transaction.quantity),
      unitPrice: toDecimalString(transaction.unitPrice),
      amount: toDecimalString(transaction.amount),
      currency: currencyForPayload,
      fee: toDecimalString(transaction.fee),
      tax: toDecimalString(transaction.tax),
      fxRate,
      notes: transaction.comment?.trim() || undefined,
      metadata: metadataJson,
    };

    // Clear quantity/unitPrice for split activities (they use splitRatio in amount instead)
    if (basePayload.activityType === ActivityType.SPLIT) {
      basePayload.quantity = undefined;
      basePayload.unitPrice = undefined;
    }

    if (isNew) {
      const createPayload: ActivityCreatePayload = { ...basePayload };
      const idempotencyKey = normalizeOptionalString(transaction.idempotencyKey);
      if (idempotencyKey) {
        createPayload.idempotencyKey = idempotencyKey;
      }

      if (!isCash) {
        // For NEW market activities: send asset identity for backend resolution.
        const symbol = (transaction.assetSymbol || "").trim().toUpperCase();
        if (symbol) {
          createPayload.asset = buildAssetResolutionInput({
            id: transaction.pendingAssetId,
            symbol,
            exchangeMic: normalizeOptionalString(transaction.exchangeMic),
            kind: normalizeOptionalString(transaction.pendingAssetKind),
            name: normalizeOptionalString(transaction.pendingAssetName),
            quoteMode: normalizeOptionalString(transaction.assetQuoteMode),
            quoteCcy: normalizeOptionalString(transaction.pendingQuoteCcy),
            instrumentType: normalizeOptionalString(transaction.pendingInstrumentType),
            providerId: transaction.pendingProviderId,
            providerSymbol: transaction.pendingProviderSymbol,
          });
        }
      }
      // For cash activities: don't send asset - backend generates CASH:{currency}

      creates.push(createPayload);
    } else {
      // Build UPDATE payload
      const updatePayload: ActivityUpdatePayload = {
        ...basePayload,
        subtype: transaction.subtype ?? "",
      };

      if (!isCash) {
        const currentSymbol = (transaction.assetSymbol || "").trim().toUpperCase();
        const originalSymbol = (transaction._originalAssetSymbol || "").trim().toUpperCase();
        const currentExchangeMic = (
          normalizeOptionalString(transaction.exchangeMic) ?? ""
        ).toUpperCase();
        const originalExchangeMic = (
          normalizeOptionalString(transaction._originalExchangeMic) ?? ""
        ).toUpperCase();
        const currentInstrumentType = (
          normalizeOptionalString(transaction.instrumentType) ??
          normalizeOptionalString(transaction.pendingInstrumentType) ??
          ""
        ).toUpperCase();
        const originalInstrumentType = (
          normalizeOptionalString(transaction._originalInstrumentType) ?? ""
        ).toUpperCase();
        const symbolChanged = currentSymbol !== originalSymbol;
        const exchangeChanged = currentExchangeMic !== originalExchangeMic;
        const instrumentTypeChanged = currentInstrumentType !== originalInstrumentType;
        const hasPendingQuoteCcy = !!normalizeOptionalString(transaction.pendingQuoteCcy);
        const hasPendingProviderRef =
          !!transaction.pendingProviderId || !!transaction.pendingProviderSymbol;
        const identityChanged =
          symbolChanged ||
          exchangeChanged ||
          instrumentTypeChanged ||
          hasPendingQuoteCcy ||
          hasPendingProviderRef;

        if (identityChanged && currentSymbol) {
          // Asset identity changed: send id + natural identity for backend verification/re-resolution.
          updatePayload.asset = buildAssetResolutionInput({
            id: transaction.pendingAssetId ?? transaction._originalAssetId,
            symbol: currentSymbol,
            exchangeMic: normalizeOptionalString(transaction.exchangeMic),
            kind: normalizeOptionalString(transaction.pendingAssetKind),
            name: normalizeOptionalString(transaction.pendingAssetName),
            quoteMode: normalizeOptionalString(transaction.assetQuoteMode),
            quoteCcy: normalizeOptionalString(transaction.pendingQuoteCcy),
            instrumentType:
              normalizeOptionalString(transaction.pendingInstrumentType) ??
              normalizeOptionalString(transaction.instrumentType),
            providerId: transaction.pendingProviderId,
            providerSymbol: transaction.pendingProviderSymbol,
          });
        } else if (transaction._originalAssetId) {
          // Asset identity unchanged: send id-only, with quoteMode to allow mode updates.
          updatePayload.asset = buildAssetResolutionInput({
            id: transaction._originalAssetId,
            quoteMode: transaction.assetQuoteMode,
          });
        }
      }

      updates.push(updatePayload);
    }
  }

  return {
    creates,
    updates,
    deleteIds,
  };
}

/**
 * Fields that are tracked for changes in the data grid
 */
export const TRACKED_FIELDS: (keyof LocalTransaction)[] = [
  "activityType",
  "subtype",
  "isExternal",
  "instrumentType",
  "date",
  "assetSymbol",
  "quantity",
  "unitPrice",
  "amount",
  "fee",
  "tax",
  "fxRate",
  "accountId",
  "currency",
  "comment",
];

/**
 * Column IDs that should be pinned to the left/right of the grid
 */
export const PINNED_COLUMNS = {
  left: ["select", "status", "date", "accountName", "activityType"] as const,
  right: ["actions"] as const,
};

/**
 * Validation error for a transaction
 */
export interface TransactionValidationError {
  transactionId: string;
  field: string;
  message: string;
}

/**
 * Result of validating transactions before save
 */
export interface ValidationResult {
  isValid: boolean;
  errors: TransactionValidationError[];
}

/**
 * Validates a single transaction before save
 */
function validateTransaction(transaction: LocalTransaction): TransactionValidationError[] {
  const errors: TransactionValidationError[] = [];

  // Required field: accountId
  if (!transaction.accountId?.trim()) {
    errors.push({
      transactionId: transaction.id,
      field: "accountId",
      message: "Account is required",
    });
  }

  // Required field: activityType
  if (!transaction.activityType) {
    errors.push({
      transactionId: transaction.id,
      field: "activityType",
      message: "Activity type is required",
    });
  }

  // Required field: date
  if (!transaction.date) {
    errors.push({
      transactionId: transaction.id,
      field: "date",
      message: "Date is required",
    });
  }

  // Non-cash and asset-backed income activities require a symbol
  if (isAssetIdentityRequired(transaction.activityType, transaction.subtype)) {
    const hasSymbol = transaction.assetSymbol?.trim() || transaction.assetId?.trim();
    if (!hasSymbol) {
      errors.push({
        transactionId: transaction.id,
        field: "assetSymbol",
        message: "Symbol is required for this activity type",
      });
    }
  }

  if (isAssetBackedIncomeSubtype(transaction.activityType, transaction.subtype)) {
    const quantity = transaction.quantity != null ? Number.parseFloat(transaction.quantity) : NaN;
    const unitPrice =
      transaction.unitPrice != null ? Number.parseFloat(transaction.unitPrice) : NaN;
    const amount = transaction.amount != null ? Number.parseFloat(transaction.amount) : NaN;

    if (!(quantity > 0)) {
      errors.push({
        transactionId: transaction.id,
        field: "quantity",
        message: "Received quantity is required",
      });
    }
    if (!(unitPrice > 0) && !(amount > 0)) {
      errors.push({
        transactionId: transaction.id,
        field: "unitPrice",
        message: "Either income amount or FMV per unit is required",
      });
    }
  }

  // Stored numeric magnitudes are unsigned; activity type controls direction.
  for (const [field, value, label] of [
    ["quantity", transaction.quantity, "Quantity"],
    ["unitPrice", transaction.unitPrice, "Price"],
    ["amount", transaction.amount, "Amount"],
  ] as const) {
    if (value != null && Number.parseFloat(value) < 0) {
      errors.push({
        transactionId: transaction.id,
        field,
        message: `${label} cannot be negative`,
      });
    }
  }

  if (transaction.fee != null && parseFloat(transaction.fee) < 0) {
    errors.push({
      transactionId: transaction.id,
      field: "fee",
      message: "Fee cannot be negative",
    });
  }

  if (transaction.tax != null && parseFloat(transaction.tax) < 0) {
    errors.push({
      transactionId: transaction.id,
      field: "tax",
      message: "Tax cannot be negative",
    });
  }

  if (transaction.fxRate != null && parseFloat(transaction.fxRate) < 0) {
    errors.push({
      transactionId: transaction.id,
      field: "fxRate",
      message: "FX rate cannot be negative",
    });
  }

  const cashImpactingTypes: readonly string[] = [
    ActivityType.BUY,
    ActivityType.SELL,
    ActivityType.DEPOSIT,
    ActivityType.WITHDRAWAL,
    ActivityType.DIVIDEND,
    ActivityType.INTEREST,
    ActivityType.CREDIT,
    ActivityType.FEE,
    ActivityType.TAX,
    ActivityType.TRANSFER_IN,
    ActivityType.TRANSFER_OUT,
  ];
  const isCashImpacting = cashImpactingTypes.includes(transaction.activityType);
  const isSecurityTransfer = isSecuritiesTransfer(
    transaction.activityType,
    transaction.assetSymbol,
    transaction.assetId,
  );
  const resolvedCashAmount =
    isCashImpacting && !isSecurityTransfer ? resolveActivityCash(transaction).amount : null;
  if (
    isCashImpacting &&
    !isSecurityTransfer &&
    (resolvedCashAmount == null || resolvedCashAmount <= 0)
  ) {
    errors.push({
      transactionId: transaction.id,
      field: "amount",
      message: "A positive total is required or must be derivable",
    });
  }

  const amount = transaction.amount == null ? NaN : Number.parseFloat(transaction.amount);
  const charges = Number(transaction.fee || 0) + Number(transaction.tax || 0);
  const isCashOutflowWithGross =
    transaction.activityType === ActivityType.BUY ||
    transaction.activityType === ActivityType.WITHDRAWAL ||
    (transaction.activityType === ActivityType.TRANSFER_OUT &&
      isCashTransfer(
        transaction.activityType,
        transaction.assetSymbol,
        transaction.assetId,
      ));
  if (isCashOutflowWithGross && amount > 0 && amount <= charges) {
    errors.push({
      transactionId: transaction.id,
      field: "amount",
      message: "Total must be greater than fees and taxes",
    });
  }

  return errors;
}

/**
 * Validates all dirty transactions before save
 */
export function validateTransactionsForSave(
  localTransactions: LocalTransaction[],
  dirtyTransactionIds: Set<string>,
): ValidationResult {
  const errors: TransactionValidationError[] = [];

  const dirtyTransactions = localTransactions.filter((transaction) =>
    dirtyTransactionIds.has(transaction.id),
  );

  for (const transaction of dirtyTransactions) {
    const transactionErrors = validateTransaction(transaction);
    errors.push(...transactionErrors);
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
