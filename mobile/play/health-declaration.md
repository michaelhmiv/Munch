# Google Play Health apps declaration — Munch

Package: `business.munch.app`

Munch is a consumer **health and fitness** app. The Play Console Health apps declaration is required even for closed testing.

## Health features to select

Select:

- **Health and fitness > Nutrition and Weight Management**

This category matches Munch because it tracks dietary intake/nutrients, supports meal planning, stores body weight and weight/nutrition goals, and helps users manage nutrition-related goals.

Do **not** select these unless the shipped product changes:

- Medical / clinical functionality
- Disease management
- Medication management
- Human Subjects Research
- Health Connect
- Activity/fitness sensor tracking
- Period tracking
- Sleep management
- Government/public-health affiliation

Munch does not currently read or write Health Connect and does not request medical-record data.

## Required health disclaimer

The Play full description contains the release disclaimer:

> Munch is a consumer wellness and nutrition-tracking product. It is not a medical device and does not diagnose, treat, cure, or prevent any medical condition. Nutrition values and AI-assisted estimates can be incomplete or inaccurate. Consult a qualified healthcare professional for medical advice, diagnosis, or treatment.

Keep equivalent language in the listing and in-product legal/wellness surfaces. Do not make diagnosis, treatment, disease-management, clinical-dosing, guaranteed-weight-loss, or other medical claims without a deliberate product/legal review.

## Privacy requirements

Privacy Policy: `https://munch.business/privacy`

The policy must continue to disclose:

- nutrition and weight records
- water and user-defined goals
- Pantry/receipt photo processing
- AI-assisted Pantry planning
- Google Play and Stripe billing metadata
- service providers
- export/deletion/retention
- security practices

## Developer account type checkpoint

Google's account-type documentation says Organization accounts should be used for Health apps and gives Medical apps and Human Subjects Research apps as examples. The separate Health categorization guidance distinguishes general health-and-fitness apps such as nutrition trackers from Medical and Human Subjects Research apps. Because Munch is a general consumer Nutrition and Weight Management app—not a Medical or research app—do **not** block the release pipeline solely on an assumed account conversion.

Use the existing Play account if Play Console accepts the Munch declaration/account combination. If Play Console explicitly requires Organization verification for this app/account at submission time, complete the account conversion/D-U-N-S process before review. This is a Play account decision, not a package/code change.

## Submission check

Immediately before closed testing:

1. Confirm the final listing still contains the disclaimer.
2. Confirm Health declaration category remains Nutrition and Weight Management.
3. Confirm no Health Connect permissions were added to the merged artifact.
4. Confirm camera/photo handling disclosures match the current app behavior.
5. Answer any new Play health questions based on the shipped feature set, not this document's historical wording.
