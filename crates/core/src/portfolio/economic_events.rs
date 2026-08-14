use crate::activities::{
    is_cash_symbol, Activity, ACTIVITY_SUBTYPE_BONUS, ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_CREDIT,
    ACTIVITY_TYPE_DEPOSIT, ACTIVITY_TYPE_DIVIDEND, ACTIVITY_TYPE_FEE, ACTIVITY_TYPE_INTEREST,
    ACTIVITY_TYPE_SELL, ACTIVITY_TYPE_SPLIT, ACTIVITY_TYPE_TAX, ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::fx::currency::{normalize_amount, normalize_currency_code};
use crate::portfolio::valuation::ExternalFlowSource;
use crate::quotes::Quote;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EconomicEventKind {
    CashFlow,
    ExternalSecurityDeliveryIn,
    ExternalSecurityDeliveryOut,
    InternalSecurityTransfer,
    Trade,
    Income,
    Fee,
    Tax,
    UnknownBoundaryTransfer,
    Other,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BasisStatus {
    Complete,
    PartialUnknown,
    Unknown,
    #[default]
    NotApplicable,
}

impl BasisStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "COMPLETE",
            Self::PartialUnknown => "PARTIAL_UNKNOWN",
            Self::Unknown => "UNKNOWN",
            Self::NotApplicable => "NOT_APPLICABLE",
        }
    }

    pub fn from_code(value: &str) -> Self {
        match value.trim().to_ascii_uppercase().as_str() {
            "COMPLETE" => Self::Complete,
            "PARTIAL_UNKNOWN" | "PARTIAL" => Self::PartialUnknown,
            "UNKNOWN" => Self::Unknown,
            "NOT_APPLICABLE" | "N/A" | "NA" => Self::NotApplicable,
            _ => Self::Unknown,
        }
    }

    pub fn combine(self, next: Self) -> Self {
        match (self, next) {
            (Self::PartialUnknown, _) | (_, Self::PartialUnknown) => Self::PartialUnknown,
            (Self::Complete, Self::Unknown) | (Self::Unknown, Self::Complete) => {
                Self::PartialUnknown
            }
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            (Self::Complete, _) | (_, Self::Complete) => Self::Complete,
            (Self::NotApplicable, Self::NotApplicable) => Self::NotApplicable,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferBoundary {
    Internal,
    External,
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedActivityEconomics {
    pub kind: EconomicEventKind,
    pub lot_cost_basis_value: Decimal,
    pub lot_cost_basis_currency: String,
    pub performance_flow_value: Decimal,
    pub performance_flow_currency: String,
    pub performance_flow_source: ExternalFlowSource,
    pub basis_status: BasisStatus,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EconomicEventEffect {
    pub activity_id: String,
    pub account_id: String,
    pub asset_id: Option<String>,
    pub date: NaiveDate,
    pub event_kind: EconomicEventKind,
    /// Signed external flow. Positive means contribution; negative means distribution.
    pub external_flow: Decimal,
    pub realized_pnl: Decimal,
    pub unrealized_movement: Decimal,
    pub income: Decimal,
    pub fee: Decimal,
    pub tax: Decimal,
    pub fx_effect: Decimal,
    pub diagnostics: Vec<String>,
}

impl EconomicEventEffect {
    pub fn empty(activity: &Activity, date: NaiveDate, event_kind: EconomicEventKind) -> Self {
        Self {
            activity_id: activity.id.clone(),
            account_id: activity.account_id.clone(),
            asset_id: activity.asset_id.clone(),
            date,
            event_kind,
            external_flow: Decimal::ZERO,
            realized_pnl: Decimal::ZERO,
            unrealized_movement: Decimal::ZERO,
            income: Decimal::ZERO,
            fee: Decimal::ZERO,
            tax: Decimal::ZERO,
            fx_effect: Decimal::ZERO,
            diagnostics: Vec::new(),
        }
    }
}

pub struct ActivityEconomicsResolver;

/// Flat inputs used to resolve the cash economics of persisted, imported, and
/// not-yet-persisted activities. Monetary values are magnitudes; the activity
/// type is the sole source of direction.
#[derive(Clone, Copy, Debug)]
pub struct ActivityCashInputs<'a> {
    pub activity_type: &'a str,
    pub is_security_transfer: bool,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    pub amount: Option<Decimal>,
    pub fee: Option<Decimal>,
    pub tax: Option<Decimal>,
    pub unit_multiplier: Decimal,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ResolvedActivityCash {
    /// Authoritative final cash magnitude, including fees and taxes.
    pub amount: Option<Decimal>,
    /// Cash magnitude derived from quantity, price, multiplier, and charges.
    pub expected_amount: Option<Decimal>,
    /// Signed cash movement. Positive is an inflow; negative is an outflow.
    pub signed_cash_effect: Decimal,
    /// Pre-charge economics used for lots, cost basis, and realized P/L.
    pub gross_amount: Option<Decimal>,
    pub amount_was_derived: bool,
}

impl ActivityEconomicsResolver {
    pub fn resolve_cash(activity: &Activity, unit_multiplier: Decimal) -> ResolvedActivityCash {
        Self::resolve_cash_inputs(ActivityCashInputs {
            activity_type: activity.effective_type(),
            is_security_transfer: Self::is_security_transfer(activity),
            quantity: activity.quantity,
            unit_price: activity.unit_price,
            amount: activity.amount,
            fee: activity.fee,
            tax: activity.tax,
            unit_multiplier,
        })
    }

    pub fn resolve_cash_inputs(inputs: ActivityCashInputs<'_>) -> ResolvedActivityCash {
        if inputs.activity_type == ACTIVITY_TYPE_SPLIT || inputs.is_security_transfer {
            return ResolvedActivityCash::default();
        }

        let fee = inputs.fee.unwrap_or(Decimal::ZERO).abs();
        let tax = inputs.tax.unwrap_or(Decimal::ZERO).abs();
        let charges = fee + tax;
        let expected_amount = Self::derived_cash_amount(inputs, fee, tax);
        let supplied_amount = inputs.amount.map(|amount| amount.abs());
        let amount = supplied_amount.or(expected_amount);
        let amount_was_derived = supplied_amount.is_none() && amount.is_some();

        let signed_cash_effect = amount
            .map(|amount| match inputs.activity_type {
                ACTIVITY_TYPE_SELL
                | ACTIVITY_TYPE_DEPOSIT
                | ACTIVITY_TYPE_DIVIDEND
                | ACTIVITY_TYPE_INTEREST
                | ACTIVITY_TYPE_CREDIT
                | ACTIVITY_TYPE_TRANSFER_IN => amount,
                ACTIVITY_TYPE_BUY
                | ACTIVITY_TYPE_WITHDRAWAL
                | ACTIVITY_TYPE_FEE
                | ACTIVITY_TYPE_TAX
                | ACTIVITY_TYPE_TRANSFER_OUT => -amount,
                _ => Decimal::ZERO,
            })
            .unwrap_or(Decimal::ZERO);

        let gross_amount = amount.and_then(|amount| {
            let gross = match inputs.activity_type {
                ACTIVITY_TYPE_BUY => amount - charges,
                ACTIVITY_TYPE_SELL
                | ACTIVITY_TYPE_DEPOSIT
                | ACTIVITY_TYPE_DIVIDEND
                | ACTIVITY_TYPE_INTEREST
                | ACTIVITY_TYPE_CREDIT
                | ACTIVITY_TYPE_TRANSFER_IN => amount + charges,
                ACTIVITY_TYPE_WITHDRAWAL | ACTIVITY_TYPE_TRANSFER_OUT => amount - charges,
                ACTIVITY_TYPE_FEE | ACTIVITY_TYPE_TAX => amount,
                _ => return None,
            };
            (gross > Decimal::ZERO).then_some(gross)
        });

        ResolvedActivityCash {
            amount,
            expected_amount,
            signed_cash_effect,
            gross_amount,
            amount_was_derived,
        }
    }

    fn derived_cash_amount(
        inputs: ActivityCashInputs<'_>,
        fee: Decimal,
        tax: Decimal,
    ) -> Option<Decimal> {
        let charges = fee + tax;
        let multiplier = Self::valid_unit_multiplier(inputs.unit_multiplier);
        let derived_gross = match (inputs.quantity, inputs.unit_price) {
            (Some(quantity), Some(unit_price)) => {
                let gross = quantity.abs() * unit_price.abs() * multiplier;
                (gross > Decimal::ZERO).then_some(gross)
            }
            _ => None,
        };

        let derived = match inputs.activity_type {
            ACTIVITY_TYPE_BUY => derived_gross.map(|gross| gross + charges),
            ACTIVITY_TYPE_SELL
            | ACTIVITY_TYPE_DEPOSIT
            | ACTIVITY_TYPE_DIVIDEND
            | ACTIVITY_TYPE_INTEREST
            | ACTIVITY_TYPE_CREDIT
            | ACTIVITY_TYPE_TRANSFER_IN => derived_gross.map(|gross| gross - charges),
            ACTIVITY_TYPE_WITHDRAWAL | ACTIVITY_TYPE_TRANSFER_OUT => {
                derived_gross.map(|gross| gross + charges)
            }
            ACTIVITY_TYPE_FEE => (fee > Decimal::ZERO).then_some(fee),
            // Historical standalone TAX rows sometimes stored the charge in
            // `fee`. Keep that legacy fallback aligned with Activity::charge_amt_for.
            ACTIVITY_TYPE_TAX => (tax > Decimal::ZERO)
                .then_some(tax)
                .or_else(|| (fee > Decimal::ZERO).then_some(fee)),
            _ => None,
        }?;

        (derived > Decimal::ZERO).then_some(derived)
    }

    pub fn compile_activity(
        activity: &Activity,
        quote: Option<&Quote>,
        transfer_boundary: TransferBoundary,
    ) -> ResolvedActivityEconomics {
        Self::compile_activity_with_unit_multiplier(
            activity,
            quote,
            transfer_boundary,
            Decimal::ONE,
        )
    }

    pub fn compile_activity_with_unit_multiplier(
        activity: &Activity,
        quote: Option<&Quote>,
        transfer_boundary: TransferBoundary,
        unit_multiplier: Decimal,
    ) -> ResolvedActivityEconomics {
        let activity_currency = normalize_currency_code(&activity.currency).to_string();
        let kind = Self::event_kind(activity, transfer_boundary);
        let is_security_transfer = Self::is_security_transfer(activity);
        let unit_multiplier = Self::valid_unit_multiplier(unit_multiplier);
        let lot_cost_basis_value = if is_security_transfer {
            Self::lot_cost_basis_value_with_unit_multiplier(activity, unit_multiplier)
        } else {
            Decimal::ZERO
        };
        let lot_cost_basis_uses_legacy_amount =
            is_security_transfer && Self::lot_cost_basis_uses_legacy_amount(activity);
        let mut diagnostics = Vec::new();

        if kind == EconomicEventKind::UnknownBoundaryTransfer {
            diagnostics.push(format!(
                "Transfer activity {} has no valid pair and is not explicitly external.",
                activity.id
            ));
        }

        if kind == EconomicEventKind::InternalSecurityTransfer {
            return ResolvedActivityEconomics {
                kind,
                lot_cost_basis_value,
                lot_cost_basis_currency: activity_currency.clone(),
                performance_flow_value: Decimal::ZERO,
                performance_flow_currency: activity_currency,
                performance_flow_source: ExternalFlowSource::Unknown,
                basis_status: if is_security_transfer {
                    Self::security_transfer_basis_status(activity)
                } else {
                    BasisStatus::NotApplicable
                },
                diagnostics,
            };
        }

        if is_security_transfer {
            if let Some(quote) = quote {
                let (normalized_price, normalized_currency) =
                    normalize_amount(quote.close, &quote.currency);
                let market_value = activity.qty() * normalized_price * unit_multiplier;
                if !market_value.is_zero() {
                    return ResolvedActivityEconomics {
                        kind,
                        lot_cost_basis_value,
                        lot_cost_basis_currency: activity_currency,
                        performance_flow_value: market_value.abs(),
                        performance_flow_currency: normalize_currency_code(normalized_currency)
                            .to_string(),
                        performance_flow_source: if kind
                            == EconomicEventKind::UnknownBoundaryTransfer
                        {
                            ExternalFlowSource::UnknownBoundaryTransfer
                        } else {
                            ExternalFlowSource::QuoteDerivedMarketValue
                        },
                        basis_status: Self::security_transfer_basis_status(activity),
                        diagnostics,
                    };
                }
            }

            if activity.effective_type() == ACTIVITY_TYPE_TRANSFER_OUT {
                diagnostics.push(format!(
                    "Security transfer-out activity {} deferred performance flow to removed lot basis because no transfer-date quote was available.",
                    activity.id
                ));
                return ResolvedActivityEconomics {
                    kind,
                    lot_cost_basis_value,
                    lot_cost_basis_currency: activity_currency.clone(),
                    performance_flow_value: Decimal::ZERO,
                    performance_flow_currency: activity_currency,
                    performance_flow_source: if kind == EconomicEventKind::UnknownBoundaryTransfer {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    } else {
                        ExternalFlowSource::Unknown
                    },
                    basis_status: if lot_cost_basis_value.is_zero() {
                        BasisStatus::Unknown
                    } else {
                        BasisStatus::Complete
                    },
                    diagnostics,
                };
            }

            if !lot_cost_basis_value.is_zero() {
                if lot_cost_basis_uses_legacy_amount {
                    diagnostics.push(format!(
                        "Security transfer activity {} used legacy activity amount as cost basis and performance flow fallback because quote and unit price were unavailable.",
                        activity.id
                    ));
                } else {
                    diagnostics.push(format!(
                        "Security transfer activity {} used cost basis as performance flow fallback because no transfer-date quote was available.",
                        activity.id
                    ));
                }
                return ResolvedActivityEconomics {
                    kind,
                    lot_cost_basis_value,
                    lot_cost_basis_currency: activity_currency.clone(),
                    performance_flow_value: lot_cost_basis_value.abs(),
                    performance_flow_currency: activity_currency,
                    performance_flow_source: if kind == EconomicEventKind::UnknownBoundaryTransfer {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    } else if lot_cost_basis_uses_legacy_amount {
                        ExternalFlowSource::LegacyActivityAmountFallback
                    } else {
                        ExternalFlowSource::CostBasisFallback
                    },
                    basis_status: BasisStatus::Complete,
                    diagnostics,
                };
            }

            if let Some(amount) = activity.amount.filter(|amount| !amount.is_zero()) {
                diagnostics.push(format!(
                    "Security transfer activity {} used legacy activity amount as performance flow fallback because quote and cost basis were unavailable.",
                    activity.id
                ));
                return ResolvedActivityEconomics {
                    kind,
                    lot_cost_basis_value,
                    lot_cost_basis_currency: activity_currency.clone(),
                    performance_flow_value: amount.abs(),
                    performance_flow_currency: activity_currency,
                    performance_flow_source: if kind == EconomicEventKind::UnknownBoundaryTransfer {
                        ExternalFlowSource::UnknownBoundaryTransfer
                    } else {
                        ExternalFlowSource::LegacyActivityAmountFallback
                    },
                    basis_status: BasisStatus::Unknown,
                    diagnostics,
                };
            }

            diagnostics.push(format!(
                "Security transfer activity {} has no quote, cost basis, or legacy amount for performance flow.",
                activity.id
            ));
            return ResolvedActivityEconomics {
                kind,
                lot_cost_basis_value,
                lot_cost_basis_currency: activity_currency.clone(),
                performance_flow_value: Decimal::ZERO,
                performance_flow_currency: activity_currency,
                performance_flow_source: ExternalFlowSource::UnknownBoundaryTransfer,
                basis_status: BasisStatus::Unknown,
                diagnostics,
            };
        }

        if kind == EconomicEventKind::UnknownBoundaryTransfer {
            return ResolvedActivityEconomics {
                kind,
                lot_cost_basis_value,
                lot_cost_basis_currency: activity_currency.clone(),
                performance_flow_value: Decimal::ZERO,
                performance_flow_currency: activity_currency,
                performance_flow_source: ExternalFlowSource::UnknownBoundaryTransfer,
                basis_status: BasisStatus::NotApplicable,
                diagnostics,
            };
        }

        let performance_flow_value = Self::cash_or_legacy_flow_amount(activity);
        let performance_flow_source = if performance_flow_value.is_zero() {
            ExternalFlowSource::Unknown
        } else {
            ExternalFlowSource::CashAmount
        };

        ResolvedActivityEconomics {
            kind,
            lot_cost_basis_value,
            lot_cost_basis_currency: activity_currency.clone(),
            performance_flow_value,
            performance_flow_currency: activity_currency,
            performance_flow_source,
            basis_status: BasisStatus::NotApplicable,
            diagnostics,
        }
    }

    pub fn is_security_transfer(activity: &Activity) -> bool {
        matches!(
            activity.effective_type(),
            ACTIVITY_TYPE_TRANSFER_IN | ACTIVITY_TYPE_TRANSFER_OUT
        ) && activity.asset_id.as_deref().is_some_and(|asset_id| {
            let asset_id = asset_id.trim();
            !asset_id.is_empty() && !is_cash_symbol(asset_id)
        })
    }

    pub fn lot_cost_basis_value(activity: &Activity) -> Decimal {
        Self::lot_cost_basis_value_with_unit_multiplier(activity, Decimal::ONE)
    }

    pub fn lot_cost_basis_value_with_unit_multiplier(
        activity: &Activity,
        unit_multiplier: Decimal,
    ) -> Decimal {
        let quantity = activity.qty();
        let price_basis =
            quantity * activity.price() * Self::valid_unit_multiplier(unit_multiplier);
        if !price_basis.is_zero() {
            return price_basis;
        }

        if activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN && !quantity.is_zero() {
            activity.amount.unwrap_or(Decimal::ZERO).abs()
        } else {
            Decimal::ZERO
        }
    }

    fn lot_cost_basis_uses_legacy_amount(activity: &Activity) -> bool {
        let unit_price_missing_or_zero = activity
            .unit_price
            .map(|unit_price| unit_price.is_zero())
            .unwrap_or(true);

        activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN
            && activity.quantity.is_some_and(|qty| !qty.is_zero())
            && unit_price_missing_or_zero
            && activity.amount.is_some_and(|amount| !amount.is_zero())
    }

    pub fn security_transfer_has_book_basis(activity: &Activity) -> bool {
        Self::is_security_transfer(activity)
            && activity.quantity.is_some_and(|qty| !qty.is_zero())
            && (activity.unit_price.is_some_and(|price| !price.is_zero())
                || (activity.effective_type() == ACTIVITY_TYPE_TRANSFER_IN
                    && activity.amount.is_some_and(|amount| !amount.is_zero())))
    }

    fn security_transfer_basis_status(activity: &Activity) -> BasisStatus {
        if Self::security_transfer_has_book_basis(activity) {
            BasisStatus::Complete
        } else {
            BasisStatus::Unknown
        }
    }

    fn event_kind(activity: &Activity, transfer_boundary: TransferBoundary) -> EconomicEventKind {
        match activity.effective_type() {
            ACTIVITY_TYPE_DEPOSIT | ACTIVITY_TYPE_WITHDRAWAL => EconomicEventKind::CashFlow,
            ACTIVITY_TYPE_CREDIT
                if activity.subtype.as_deref().is_some_and(|subtype| {
                    subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_BONUS)
                }) =>
            {
                EconomicEventKind::CashFlow
            }
            ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL => EconomicEventKind::Trade,
            ACTIVITY_TYPE_DIVIDEND | ACTIVITY_TYPE_INTEREST | ACTIVITY_TYPE_CREDIT => {
                EconomicEventKind::Income
            }
            ACTIVITY_TYPE_FEE => EconomicEventKind::Fee,
            ACTIVITY_TYPE_TAX => EconomicEventKind::Tax,
            ACTIVITY_TYPE_TRANSFER_IN | ACTIVITY_TYPE_TRANSFER_OUT => {
                Self::transfer_event_kind(activity, transfer_boundary)
            }
            _ => EconomicEventKind::Other,
        }
    }

    fn transfer_event_kind(
        activity: &Activity,
        transfer_boundary: TransferBoundary,
    ) -> EconomicEventKind {
        match transfer_boundary {
            TransferBoundary::Internal => EconomicEventKind::InternalSecurityTransfer,
            TransferBoundary::Unknown => EconomicEventKind::UnknownBoundaryTransfer,
            TransferBoundary::External => match activity.effective_type() {
                ACTIVITY_TYPE_TRANSFER_IN if Self::is_security_transfer(activity) => {
                    EconomicEventKind::ExternalSecurityDeliveryIn
                }
                ACTIVITY_TYPE_TRANSFER_OUT if Self::is_security_transfer(activity) => {
                    EconomicEventKind::ExternalSecurityDeliveryOut
                }
                _ => EconomicEventKind::CashFlow,
            },
        }
    }

    fn cash_or_legacy_flow_amount(activity: &Activity) -> Decimal {
        Self::resolve_cash(activity, Decimal::ONE)
            .amount
            .unwrap_or(Decimal::ZERO)
    }

    fn valid_unit_multiplier(unit_multiplier: Decimal) -> Decimal {
        if unit_multiplier > Decimal::ZERO {
            unit_multiplier
        } else {
            Decimal::ONE
        }
    }
}

#[cfg(test)]
mod cash_tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn inputs(activity_type: &'static str) -> ActivityCashInputs<'static> {
        ActivityCashInputs {
            activity_type,
            is_security_transfer: false,
            quantity: Some(dec!(2)),
            unit_price: Some(dec!(10)),
            amount: None,
            fee: Some(dec!(1)),
            tax: Some(dec!(2)),
            unit_multiplier: Decimal::ONE,
        }
    }

    #[test]
    fn supplied_trade_amount_is_authoritative_and_type_controls_direction() {
        let mut buy = inputs(ACTIVITY_TYPE_BUY);
        buy.amount = Some(dec!(-12));
        let buy = ActivityEconomicsResolver::resolve_cash_inputs(buy);
        assert_eq!(buy.amount, Some(dec!(12)));
        assert_eq!(buy.expected_amount, Some(dec!(23)));
        assert_eq!(buy.signed_cash_effect, dec!(-12));
        assert_eq!(buy.gross_amount, Some(dec!(9)));
        assert!(!buy.amount_was_derived);

        let mut sell = inputs(ACTIVITY_TYPE_SELL);
        sell.amount = Some(dec!(-12));
        let sell = ActivityEconomicsResolver::resolve_cash_inputs(sell);
        assert_eq!(sell.signed_cash_effect, dec!(12));
        assert_eq!(sell.gross_amount, Some(dec!(15)));
    }

    #[test]
    fn missing_trade_amount_is_derived_with_multiplier_and_charges() {
        let mut buy = inputs(ACTIVITY_TYPE_BUY);
        buy.unit_multiplier = dec!(100);
        let buy = ActivityEconomicsResolver::resolve_cash_inputs(buy);
        assert_eq!(buy.amount, Some(dec!(2003)));
        assert_eq!(buy.signed_cash_effect, dec!(-2003));
        assert_eq!(buy.gross_amount, Some(dec!(2000)));
        assert!(buy.amount_was_derived);

        let sell = ActivityEconomicsResolver::resolve_cash_inputs(inputs(ACTIVITY_TYPE_SELL));
        assert_eq!(sell.amount, Some(dec!(17)));
        assert_eq!(sell.signed_cash_effect, dec!(17));
        assert_eq!(sell.gross_amount, Some(dec!(20)));
    }

    #[test]
    fn standalone_charges_and_security_transfers_follow_cash_contract() {
        let mut fee = inputs(ACTIVITY_TYPE_FEE);
        fee.amount = None;
        assert_eq!(
            ActivityEconomicsResolver::resolve_cash_inputs(fee).signed_cash_effect,
            dec!(-1)
        );

        let mut tax = inputs(ACTIVITY_TYPE_TAX);
        tax.amount = None;
        assert_eq!(
            ActivityEconomicsResolver::resolve_cash_inputs(tax).signed_cash_effect,
            dec!(-2)
        );

        let mut legacy_tax = inputs(ACTIVITY_TYPE_TAX);
        legacy_tax.amount = None;
        legacy_tax.tax = None;
        assert_eq!(
            ActivityEconomicsResolver::resolve_cash_inputs(legacy_tax).signed_cash_effect,
            dec!(-1)
        );

        let mut transfer = inputs(ACTIVITY_TYPE_TRANSFER_IN);
        transfer.amount = Some(dec!(25));
        transfer.is_security_transfer = true;
        assert_eq!(
            ActivityEconomicsResolver::resolve_cash_inputs(transfer),
            ResolvedActivityCash::default()
        );
    }

    #[test]
    fn reported_fractional_drip_buy_trusts_cash_amount_and_preserves_trade_details() {
        let resolved = ActivityEconomicsResolver::resolve_cash_inputs(ActivityCashInputs {
            activity_type: ACTIVITY_TYPE_BUY,
            is_security_transfer: false,
            quantity: Some(dec!(0.001)),
            unit_price: Some(dec!(589.8108)),
            amount: Some(dec!(-0.30)),
            fee: None,
            tax: None,
            unit_multiplier: Decimal::ONE,
        });

        assert_eq!(resolved.amount, Some(dec!(0.30)));
        assert_eq!(resolved.signed_cash_effect, dec!(-0.30));
        assert_eq!(resolved.expected_amount, Some(dec!(0.5898108)));
        assert_eq!(resolved.gross_amount, Some(dec!(0.30)));
        assert!(!resolved.amount_was_derived);
    }
}
