//! Diagnostics for authoritative activity cash amounts.

use async_trait::async_trait;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::errors::Result;
use crate::health::model::{
    AffectedItem, DiagnosticDomain, Evidence, HealthCategory, HealthDiagnostic, HealthEntityRef,
    HealthIssue, NavigateAction, Severity,
};
use crate::health::traits::{HealthCheck, HealthContext};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActivityCashIssueKind {
    Mismatch,
    Missing,
}

#[derive(Debug, Clone)]
pub struct ActivityCashIssueInfo {
    pub kind: ActivityCashIssueKind,
    pub activity_id: String,
    pub account_name: String,
    pub activity_type: String,
    pub date: NaiveDate,
    pub currency: String,
    pub trusted_amount: Option<Decimal>,
    pub expected_amount: Option<Decimal>,
    pub difference: Option<Decimal>,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    pub fee: Decimal,
    pub tax: Decimal,
}

pub struct ActivityCashIntegrityCheck;

impl ActivityCashIntegrityCheck {
    pub fn new() -> Self {
        Self
    }

    pub fn analyze(
        &self,
        findings: &[ActivityCashIssueInfo],
        _ctx: &HealthContext,
    ) -> Vec<HealthIssue> {
        findings.iter().map(issue_for_finding).collect()
    }
}

impl Default for ActivityCashIntegrityCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheck for ActivityCashIntegrityCheck {
    fn id(&self) -> &'static str {
        "activity_cash_integrity"
    }

    fn category(&self) -> HealthCategory {
        HealthCategory::DataConsistency
    }

    async fn run(&self, _ctx: &HealthContext) -> Result<Vec<HealthIssue>> {
        Ok(Vec::new())
    }
}

fn issue_for_finding(finding: &ActivityCashIssueInfo) -> HealthIssue {
    let (code, severity, title, message) = match finding.kind {
        ActivityCashIssueKind::Mismatch => (
            "activity_cash_mismatch",
            Severity::Warning,
            "Cash amount differs from trade details",
            "Wealthfolio used the trusted cash amount. Review the imported total if the difference is unexpected.",
        ),
        ActivityCashIssueKind::Missing => (
            "activity_cash_amount_missing",
            Severity::Error,
            "Activity total is missing",
            "This posted activity has no cash amount and its total cannot be derived from the available fields.",
        ),
    };
    let navigate = NavigateAction {
        route: "/activities".to_string(),
        query: Some(json!({
            "activity": finding.activity_id,
            "healthContext": "activity"
        })),
        label: "Review Transaction".to_string(),
    };
    let details = format_details(finding);
    let data_hash = finding_hash(finding);
    let diagnostic = diagnostic_for_finding(finding, code, severity, navigate.clone());

    HealthIssue::builder()
        .id(format!("{}:{}", code, finding.activity_id))
        .severity(severity)
        .category(HealthCategory::DataConsistency)
        .code(code)
        .title(title)
        .message(message)
        .affected_count(1)
        .affected_items(vec![AffectedItem::activity(
            finding.activity_id.clone(),
            format!(
                "{} · {} · {}",
                finding.activity_type, finding.date, finding.account_name
            ),
        )])
        .navigate_action(navigate)
        .diagnostics(vec![diagnostic])
        .details(details)
        .data_hash(data_hash)
        .build()
}

fn diagnostic_for_finding(
    finding: &ActivityCashIssueInfo,
    code: &str,
    severity: Severity,
    navigate: NavigateAction,
) -> HealthDiagnostic {
    let mut diagnostic =
        HealthDiagnostic::new(code.to_ascii_uppercase(), code, format_details(finding))
            .domain(DiagnosticDomain::Ledger)
            .severity(severity)
            .date(finding.date.to_string())
            .entity(
                HealthEntityRef::new("activity", finding.activity_id.clone())
                    .label(finding.activity_type.clone())
                    .route(format!(
                        "/activities?activity={}",
                        urlencoding::encode(&finding.activity_id)
                    )),
            )
            .navigate(true, navigate)
            .evidence(Evidence::new("Currency", finding.currency.clone()))
            .evidence(Evidence::new("Quantity", decimal_text(finding.quantity)))
            .evidence(Evidence::new(
                "Unit price",
                decimal_text(finding.unit_price),
            ))
            .evidence(Evidence::new("Fee", finding.fee.to_string()))
            .evidence(Evidence::new("Tax", finding.tax.to_string()));

    if let Some(amount) = finding.trusted_amount {
        diagnostic = diagnostic.evidence(Evidence::new("Trusted cash amount", amount.to_string()));
    }
    if let Some(amount) = finding.expected_amount {
        diagnostic = diagnostic.evidence(Evidence::new("Expected amount", amount.to_string()));
    }
    if let Some(difference) = finding.difference {
        diagnostic = diagnostic.evidence(Evidence::new("Difference", difference.to_string()));
    }
    diagnostic
}

fn decimal_text(value: Option<Decimal>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "—".to_string())
}

fn format_details(finding: &ActivityCashIssueInfo) -> String {
    match finding.kind {
        ActivityCashIssueKind::Mismatch => format!(
            "Trusted cash amount: {} {}\nExpected from quantity × price and charges: {} {}\nDifference: {} {}\nQuantity: {}\nUnit price: {}\nFee: {}\nTax: {}\n\nWealthfolio used the trusted cash amount.",
            decimal_text(finding.trusted_amount),
            finding.currency,
            decimal_text(finding.expected_amount),
            finding.currency,
            decimal_text(finding.difference),
            finding.currency,
            decimal_text(finding.quantity),
            decimal_text(finding.unit_price),
            finding.fee,
            finding.tax,
        ),
        ActivityCashIssueKind::Missing => format!(
            "Quantity: {}\nUnit price: {}\nFee: {}\nTax: {}\n\nEnter a Total to make this activity calculable.",
            decimal_text(finding.quantity),
            decimal_text(finding.unit_price),
            finding.fee,
            finding.tax,
        ),
    }
}

fn finding_hash(finding: &ActivityCashIssueInfo) -> String {
    let mut hasher = DefaultHasher::new();
    finding.activity_id.hash(&mut hasher);
    finding.kind.hash(&mut hasher);
    finding
        .trusted_amount
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding
        .expected_amount
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding
        .difference
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding
        .quantity
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding
        .unit_price
        .map(|value| value.to_string())
        .hash(&mut hasher);
    finding.fee.to_string().hash(&mut hasher);
    finding.tax.to_string().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::HealthConfig;
    use rust_decimal_macros::dec;

    fn context() -> HealthContext {
        HealthContext::new(HealthConfig::default(), "USD", 1_000.0)
    }

    #[test]
    fn mismatch_warns_and_explains_that_trusted_cash_was_used() {
        let issues = ActivityCashIntegrityCheck::new().analyze(
            &[ActivityCashIssueInfo {
                kind: ActivityCashIssueKind::Mismatch,
                activity_id: "drip-buy".to_string(),
                account_name: "Brokerage".to_string(),
                activity_type: "BUY".to_string(),
                date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
                currency: "USD".to_string(),
                trusted_amount: Some(dec!(0.30)),
                expected_amount: Some(dec!(0.5898108)),
                difference: Some(dec!(-0.2898108)),
                quantity: Some(dec!(0.001)),
                unit_price: Some(dec!(589.8108)),
                fee: Decimal::ZERO,
                tax: Decimal::ZERO,
            }],
            &context(),
        );

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].severity, Severity::Warning);
        assert_eq!(issues[0].code.as_deref(), Some("activity_cash_mismatch"));
        assert!(issues[0]
            .details
            .as_deref()
            .unwrap()
            .contains("Wealthfolio used the trusted cash amount"));
        assert_eq!(
            issues[0]
                .navigate_action
                .as_ref()
                .map(|action| action.label.as_str()),
            Some("Review Transaction")
        );
    }

    #[test]
    fn missing_cash_amount_is_an_error() {
        let issues = ActivityCashIntegrityCheck::new().analyze(
            &[ActivityCashIssueInfo {
                kind: ActivityCashIssueKind::Missing,
                activity_id: "missing".to_string(),
                account_name: "Brokerage".to_string(),
                activity_type: "BUY".to_string(),
                date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
                currency: "USD".to_string(),
                trusted_amount: None,
                expected_amount: None,
                difference: None,
                quantity: Some(dec!(0.001)),
                unit_price: None,
                fee: Decimal::ZERO,
                tax: Decimal::ZERO,
            }],
            &context(),
        );

        assert_eq!(issues[0].severity, Severity::Error);
        assert_eq!(
            issues[0].code.as_deref(),
            Some("activity_cash_amount_missing")
        );
    }
}
