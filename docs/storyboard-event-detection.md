# Storyboard event detection

The storyboard detector uses only the frame-level probability sequence produced
by TransNetV2. It does not use histograms, optical flow, color differences, or
other image statistics.

The decision pipeline is:

1. Clamp probabilities and transform them to logits.
2. Estimate a local logit background with the median and MAD.
3. Generate high-recall local-maximum candidates.
4. Expand candidates into intervals and merge overlapping event intervals.
5. Extract event-level peak, prominence, area, width, concentration, slope,
   asymmetry, local-background, and neighboring-mass features.
6. Estimate event probability with the configured logistic-regression model.
7. Optionally apply Beta calibration.
8. Derive the decision threshold from false-positive and false-negative costs.
9. Apply deterministic non-maximum suppression.
10. Apply the minimum-shot-length sigmoid penalty and make the final decision.

The runtime model is
`src-tauri/resources/transnetv2/storyboard-event-model.json`. Its
`feature_order` is validated to prevent coefficients from being applied to the
wrong inputs. A missing model file falls back to the same
`bootstrap_uncalibrated` defaults, while a malformed model file stops detection
with an explicit error.

## Training and validation

The checked-in coefficients are startup parameters, not fitted or calibrated
production parameters. A production model must be trained on labeled candidate
events using regularized, class-weighted binary cross-entropy. Do not train on
all frames.

Split train, validation, and test data by complete video. Fit the logistic model
on the training videos, fit Beta calibration on validation videos that preserve
the real event prevalence, and use the test videos only for final reporting.
Candidate generation parameters must be frozen before measuring the test set.

Report event-level precision, recall, F1, and PR-AUC, plus false positives and
false negatives per video hour. Report exact-frame matching and tolerances of
plus or minus one and two frames. The candidate threshold is tuned for recall;
precision is controlled by the event model and the cost-derived decision
threshold.
