//! Cash-flow handlers (DEPOSIT / WITHDRAWAL / income / charge). `impl HoldingsCalculator`.
use super::super::economics::*;
use super::super::HoldingsCalculator;
use crate::activities::{Activity, ActivityType};
use crate::errors::Result;
use crate::portfolio::economic_events::ActivityEconomicsResolver;
use crate::portfolio::performance::affects_net_contribution;
use crate::portfolio::snapshot::AccountStateSnapshot;
use log::warn;
use rust_decimal::Decimal;

impl HoldingsCalculator {
    /// Handle DEPOSIT activity.
    /// Books cash inflow in ACTIVITY currency.
    /// Updates net_contribution in account currency.
    pub(crate) fn handle_deposit(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        let activity_amount =
            ActivityEconomicsResolver::resolve_cash(activity, Decimal::ONE).signed_cash_effect;
        let (cash_currency, cash_effect) =
            cash_booking(activity, account_currency, activity_amount);
        add_cash(state, &cash_currency, cash_effect);

        // Convert for net_contribution (pre-fee amount in account currency)
        let amount_acct = self.convert_to_account_currency(
            activity_amount,
            activity,
            account_currency,
            "Deposit Amount",
        );

        // Convert for net_contribution_base
        let amount_base = self.convert_account_amount_to_base_currency(
            amount_acct,
            account_currency,
            activity,
            "NetContrib Deposit",
        );

        state.net_contribution += amount_acct;
        state.net_contribution_base += amount_base;
        Ok(())
    }

    /// Handle WITHDRAWAL activity.
    /// Books cash outflow in ACTIVITY currency.
    /// Updates net_contribution in account currency.
    pub(crate) fn handle_withdrawal(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        let activity_amount =
            ActivityEconomicsResolver::resolve_cash(activity, Decimal::ONE).signed_cash_effect;
        let (cash_currency, cash_effect) =
            cash_booking(activity, account_currency, activity_amount);
        add_cash(state, &cash_currency, cash_effect);

        // Convert for net_contribution (pre-fee amount in account currency)
        let amount_acct = self.convert_to_account_currency(
            activity_amount,
            activity,
            account_currency,
            "Withdrawal Amount",
        );

        // Convert for net_contribution_base
        let amount_base = self.convert_account_amount_to_base_currency(
            amount_acct,
            account_currency,
            activity,
            "NetContrib Withdrawal",
        );

        state.net_contribution += amount_acct;
        state.net_contribution_base += amount_base;
        Ok(())
    }

    /// Handle DIVIDEND/INTEREST/CREDIT activities.
    /// Books cash inflow in ACTIVITY currency.
    ///
    /// Net contribution behavior:
    /// - External CREDIT: updates net_contribution like DEPOSIT
    /// - Internal CREDIT: no net_contribution change
    /// - DIVIDEND, INTEREST: no net_contribution change
    pub(crate) fn handle_income(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        account_currency: &str,
    ) -> Result<()> {
        let activity_amount =
            ActivityEconomicsResolver::resolve_cash(activity, Decimal::ONE).signed_cash_effect;
        let (cash_currency, cash_effect) =
            cash_booking(activity, account_currency, activity_amount);
        add_cash(state, &cash_currency, cash_effect);

        if affects_net_contribution(activity) {
            // Convert to account currency for net_contribution
            let amount_acct = self.convert_to_account_currency(
                activity_amount,
                activity,
                account_currency,
                "External Credit",
            );

            // Convert to base currency for net_contribution_base
            let amount_base = self.convert_account_amount_to_base_currency(
                amount_acct,
                account_currency,
                activity,
                "NetContrib Credit Bonus",
            );

            state.net_contribution += amount_acct;
            state.net_contribution_base += amount_base;
        }

        Ok(())
    }

    /// Handle FEE/TAX activities.
    /// Books cash outflow in ACTIVITY currency.
    /// Charges do NOT affect net_contribution.
    pub(crate) fn handle_charge(
        &self,
        activity: &Activity,
        state: &mut AccountStateSnapshot,
        activity_type: &ActivityType,
        account_currency: &str,
    ) -> Result<()> {
        let charge =
            ActivityEconomicsResolver::resolve_cash(activity, Decimal::ONE).signed_cash_effect;

        if charge == Decimal::ZERO {
            let expected_fields = match activity_type {
                ActivityType::Tax => "'tax', 'fee', and 'amount'",
                _ => "'fee' and 'amount'",
            };
            warn!(
                "Activity {} ({}): {} are zero. No cash change.",
                activity.id,
                activity_type.as_str(),
                expected_fields
            );
            return Ok(());
        }

        let (cash_currency, cash_effect) = cash_booking(activity, account_currency, charge);
        add_cash(state, &cash_currency, cash_effect);

        // Charges do not affect net_contribution
        Ok(())
    }
}
