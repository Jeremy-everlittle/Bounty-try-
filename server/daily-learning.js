'use strict';

// ═══════════════════════════════════════════════════════════════
// DAILY LEARNING — Nightly analysis & correction generation
// Queries prediction_snapshots, trades, and decision_log to
// derive data-driven corrections for the prediction engine,
// replacing hardcoded heuristics with learned adjustments.
// ═══════════════════════════════════════════════════════════════

const db = require('./db');
const store = require('./store');

class DailyLearning {
  constructor() {
    this.lastRunDate = null;
    this.analysisResults = {};
  }

  // ── Main entry: run nightly analysis ────────────────────────
  async runDailyAnalysis() {
    console.log('[daily-learning] Starting daily analysis...');
    const results = {};

    try {
      // 1. Hourly accuracy analysis
      results.hourlyStats = await this.analyzeHourlyPerformance();

      // 2. Signal effectiveness ranking
      results.signalRanking = await this.analyzeSignalEffectiveness();

      // 3. Regime performance
      results.regimePerformance = await this.analyzeRegimePerformance();

      // 4. Bet quality calibration
      results.qualityCalibration = await this.analyzeQualityFactors();

      // 5. Kelly accuracy check
      results.kellyAccuracy = await this.analyzeKellyAccuracy();

      // 6. Strategy breakdown
      results.strategyPerformance = await this.analyzeStrategyPerformance();

      // 7. Generate learned corrections
      results.corrections = this.generateCorrections(results);

      this.analysisResults = results;
      this.lastRunDate = new Date().toISOString().split('T')[0];

      console.log('[daily-learning] Analysis complete:', JSON.stringify({
        hours: Object.keys(results.hourlyStats || {}).length,
        signals: (results.signalRanking || []).length,
        regimes: Object.keys(results.regimePerformance || {}).length,
        confidenceMultiplier: results.corrections?.confidenceMultiplier,
      }));
    } catch (e) {
      console.error('[daily-learning] Analysis failed:', e.message);
    }

    return results;
  }

  // ── 1. Hourly performance ──────────────────────────────────
  // Query prediction_snapshots grouped by hour of day.
  // Returns: { [hour]: { total, correct, winRate, avgEdge, bestDirection, pnl } }
  async analyzeHourlyPerformance() {
    try {
      const snapshots = await db.getPredictionSnapshots({
        snapshotType: 'new_period',
        limit: 2000,
      });

      if (!snapshots || snapshots.length === 0) return {};

      const hourBuckets = {};

      for (const snap of snapshots) {
        if (snap.was_correct === null || snap.was_correct === undefined) continue;

        const created = snap.created_at ? new Date(snap.created_at) : null;
        if (!created) continue;
        const hour = created.getUTCHours();

        if (!hourBuckets[hour]) {
          hourBuckets[hour] = {
            total: 0, correct: 0, totalEdge: 0, totalPnl: 0,
            upCorrect: 0, upTotal: 0, downCorrect: 0, downTotal: 0,
          };
        }

        const b = hourBuckets[hour];
        b.total++;
        if (snap.was_correct) b.correct++;
        b.totalEdge += parseFloat(snap.bet_edge || 0);
        b.totalPnl += parseInt(snap.pnl_cents || 0, 10);

        if (snap.direction === 'up') {
          b.upTotal++;
          if (snap.was_correct) b.upCorrect++;
        } else if (snap.direction === 'down') {
          b.downTotal++;
          if (snap.was_correct) b.downCorrect++;
        }
      }

      // Compute derived stats
      const result = {};
      for (const [hour, b] of Object.entries(hourBuckets)) {
        const upWR = b.upTotal > 0 ? b.upCorrect / b.upTotal : 0;
        const downWR = b.downTotal > 0 ? b.downCorrect / b.downTotal : 0;
        result[hour] = {
          total: b.total,
          correct: b.correct,
          winRate: b.total > 0 ? b.correct / b.total : 0,
          avgEdge: b.total > 0 ? b.totalEdge / b.total : 0,
          bestDirection: upWR >= downWR ? 'up' : 'down',
          pnl: b.totalPnl,
        };
      }

      return result;
    } catch (e) {
      console.error('[daily-learning] hourly analysis error:', e.message);
      return {};
    }
  }

  // ── 2. Signal effectiveness ranking ────────────────────────
  // Query prediction_snapshots with signals JSONB.
  // For each signal key, compute correlation with was_correct.
  // Returns: [{ signal, correlation, importance, reliability }]
  async analyzeSignalEffectiveness() {
    try {
      const snapshots = await db.getPredictionSnapshots({
        snapshotType: 'new_period',
        limit: 2000,
      });

      if (!snapshots || snapshots.length === 0) return [];

      // Collect signal values paired with outcomes
      const signalData = {}; // { signalName: [{ value, correct }] }

      for (const snap of snapshots) {
        if (snap.was_correct === null || snap.was_correct === undefined) continue;
        if (!snap.signals || typeof snap.signals !== 'object') continue;

        const correct = snap.was_correct ? 1 : 0;

        for (const [key, value] of Object.entries(snap.signals)) {
          const numVal = parseFloat(value);
          if (isNaN(numVal)) continue;

          if (!signalData[key]) signalData[key] = [];
          signalData[key].push({ value: numVal, correct });
        }
      }

      // Compute point-biserial correlation for each signal
      const results = [];
      for (const [signal, pairs] of Object.entries(signalData)) {
        if (pairs.length < 10) continue; // need minimum sample

        const n = pairs.length;
        const correctPairs = pairs.filter(p => p.correct === 1);
        const wrongPairs = pairs.filter(p => p.correct === 0);

        if (correctPairs.length === 0 || wrongPairs.length === 0) continue;

        const meanCorrect = correctPairs.reduce((s, p) => s + p.value, 0) / correctPairs.length;
        const meanWrong = wrongPairs.reduce((s, p) => s + p.value, 0) / wrongPairs.length;
        const allMean = pairs.reduce((s, p) => s + p.value, 0) / n;
        const allStd = Math.sqrt(pairs.reduce((s, p) => s + (p.value - allMean) ** 2, 0) / n);

        if (allStd === 0) continue;

        // Point-biserial correlation
        const p1 = correctPairs.length / n;
        const correlation = ((meanCorrect - meanWrong) / allStd) * Math.sqrt(p1 * (1 - p1));

        // Importance = |correlation| * sqrt(sampleSize)
        const importance = Math.abs(correlation) * Math.sqrt(n) / Math.sqrt(100); // normalize to ~100 samples

        // Reliability = how consistent the signal is (proportion above median when correct)
        const median = pairs.map(p => p.value).sort((a, b) => a - b)[Math.floor(n / 2)];
        const correctAboveMedian = correctPairs.filter(p => p.value >= median).length;
        const reliability = correctPairs.length > 0 ? correctAboveMedian / correctPairs.length : 0.5;

        results.push({
          signal,
          correlation: Math.round(correlation * 1000) / 1000,
          importance: Math.round(importance * 1000) / 1000,
          reliability: Math.round(reliability * 1000) / 1000,
          sampleSize: n,
        });
      }

      // Sort by absolute correlation descending
      results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
      return results;
    } catch (e) {
      console.error('[daily-learning] signal analysis error:', e.message);
      return [];
    }
  }

  // ── 3. Regime performance ──────────────────────────────────
  // Query predictions grouped by vol_regime and trend_regime.
  // Returns: { [regime]: { winRate, avgPnl, sampleSize } }
  async analyzeRegimePerformance() {
    try {
      const snapshots = await db.getPredictionSnapshots({
        snapshotType: 'new_period',
        limit: 2000,
      });

      if (!snapshots || snapshots.length === 0) return {};

      const regimeBuckets = {};

      for (const snap of snapshots) {
        if (snap.was_correct === null || snap.was_correct === undefined) continue;

        const regime = snap.regime_info;
        if (!regime || typeof regime !== 'object') continue;

        // Group by vol regime
        const volRegime = regime.volRegime || regime.vol_regime || 'unknown';
        const trendRegime = regime.trendRegime || regime.trend_regime || 'unknown';

        const keys = [`vol:${volRegime}`, `trend:${trendRegime}`, `combo:${volRegime}+${trendRegime}`];

        for (const key of keys) {
          if (!regimeBuckets[key]) {
            regimeBuckets[key] = { wins: 0, total: 0, totalPnl: 0 };
          }
          regimeBuckets[key].total++;
          if (snap.was_correct) regimeBuckets[key].wins++;
          regimeBuckets[key].totalPnl += parseInt(snap.pnl_cents || 0, 10);
        }
      }

      const result = {};
      for (const [regime, b] of Object.entries(regimeBuckets)) {
        result[regime] = {
          winRate: b.total > 0 ? Math.round((b.wins / b.total) * 1000) / 1000 : 0,
          avgPnl: b.total > 0 ? Math.round(b.totalPnl / b.total) : 0,
          sampleSize: b.total,
        };
      }

      return result;
    } catch (e) {
      console.error('[daily-learning] regime analysis error:', e.message);
      return {};
    }
  }

  // ── 4. Quality factor calibration ──────────────────────────
  // Query decision_log grouped by quality factors.
  // Check if each factor actually predicts success.
  // Returns: { [factor]: { presenceWinRate, absenceWinRate, useful: boolean } }
  async analyzeQualityFactors() {
    try {
      const decisions = await db.getDecisionLog({ limit: 2000 });

      if (!decisions || decisions.length === 0) return {};

      // Track outcome by each factor's presence/absence
      const factorStats = {};

      for (const d of decisions) {
        if (d.was_correct === null || d.was_correct === undefined) continue;
        if (!d.factors || typeof d.factors !== 'object') continue;

        const correct = d.was_correct ? 1 : 0;

        for (const [factor, present] of Object.entries(d.factors)) {
          if (!factorStats[factor]) {
            factorStats[factor] = {
              presentCorrect: 0, presentTotal: 0,
              absentCorrect: 0, absentTotal: 0,
            };
          }

          if (present) {
            factorStats[factor].presentTotal++;
            factorStats[factor].presentCorrect += correct;
          } else {
            factorStats[factor].absentTotal++;
            factorStats[factor].absentCorrect += correct;
          }
        }
      }

      const result = {};
      for (const [factor, s] of Object.entries(factorStats)) {
        const presenceWinRate = s.presentTotal > 0
          ? Math.round((s.presentCorrect / s.presentTotal) * 1000) / 1000
          : 0;
        const absenceWinRate = s.absentTotal > 0
          ? Math.round((s.absentCorrect / s.absentTotal) * 1000) / 1000
          : 0;
        // Factor is useful if presence winRate is meaningfully higher than absence
        const useful = s.presentTotal >= 5 && s.absentTotal >= 5 &&
          (presenceWinRate - absenceWinRate) > 0.05;

        result[factor] = {
          presenceWinRate,
          absenceWinRate,
          presentSample: s.presentTotal,
          absentSample: s.absentTotal,
          useful,
        };
      }

      return result;
    } catch (e) {
      console.error('[daily-learning] quality factor analysis error:', e.message);
      return {};
    }
  }

  // ── 5. Kelly accuracy check ────────────────────────────────
  // Compare kelly_has_edge with actual outcomes.
  // Returns: { kellyEdgeWinRate, noKellyEdgeWinRate, kellyCalibration }
  async analyzeKellyAccuracy() {
    try {
      const snapshots = await db.getPredictionSnapshots({
        snapshotType: 'new_period',
        limit: 2000,
      });

      if (!snapshots || snapshots.length === 0) {
        return { kellyEdgeWinRate: 0, noKellyEdgeWinRate: 0, kellyCalibration: 0 };
      }

      let edgeCorrect = 0, edgeTotal = 0;
      let noEdgeCorrect = 0, noEdgeTotal = 0;

      for (const snap of snapshots) {
        if (snap.was_correct === null || snap.was_correct === undefined) continue;

        if (snap.kelly_has_edge === true) {
          edgeTotal++;
          if (snap.was_correct) edgeCorrect++;
        } else if (snap.kelly_has_edge === false) {
          noEdgeTotal++;
          if (snap.was_correct) noEdgeCorrect++;
        }
      }

      const kellyEdgeWinRate = edgeTotal > 0
        ? Math.round((edgeCorrect / edgeTotal) * 1000) / 1000
        : 0;
      const noKellyEdgeWinRate = noEdgeTotal > 0
        ? Math.round((noEdgeCorrect / noEdgeTotal) * 1000) / 1000
        : 0;

      // Calibration: how much better kelly-edge predictions actually are
      const kellyCalibration = edgeTotal > 0 && noEdgeTotal > 0
        ? Math.round((kellyEdgeWinRate - noKellyEdgeWinRate) * 1000) / 1000
        : 0;

      return {
        kellyEdgeWinRate,
        noKellyEdgeWinRate,
        kellyCalibration,
        edgeSample: edgeTotal,
        noEdgeSample: noEdgeTotal,
      };
    } catch (e) {
      console.error('[daily-learning] kelly analysis error:', e.message);
      return { kellyEdgeWinRate: 0, noKellyEdgeWinRate: 0, kellyCalibration: 0 };
    }
  }

  // ── 6. Strategy performance ────────────────────────────────
  // Query trades grouped by strategy type.
  // Returns: { [strategy]: { count, winRate, avgPnl, totalPnl } }
  async analyzeStrategyPerformance() {
    try {
      const rows = await db.getWinRateByStrategy();

      if (!rows || rows.length === 0) return {};

      const result = {};
      for (const row of rows) {
        const strategy = row.strategy || 'unknown';
        const total = parseInt(row.total, 10) || 0;
        const wins = parseInt(row.wins, 10) || 0;
        const totalPnl = parseInt(row.totalPnlCents, 10) || 0;

        result[strategy] = {
          count: total,
          winRate: total > 0 ? Math.round((wins / total) * 1000) / 1000 : 0,
          avgPnl: total > 0 ? Math.round(totalPnl / total) : 0,
          totalPnl,
        };
      }

      return result;
    } catch (e) {
      console.error('[daily-learning] strategy analysis error:', e.message);
      return {};
    }
  }

  // ── 7. Generate corrections from analysis results ──────────
  generateCorrections(results) {
    const corrections = {
      // Signal weight adjustments
      signalWeights: {},
      // Regime-specific adjustments
      regimeAdjustments: {},
      // Quality threshold updates
      qualityThresholds: {},
      // Confidence calibration
      confidenceMultiplier: 1.0,
      // Direction bias
      directionBias: 0,
    };

    // ── Signal weight adjustments ──
    if (results.signalRanking && results.signalRanking.length > 0) {
      for (const sig of results.signalRanking) {
        if (sig.reliability > 0.6 && sig.importance > 0.1) {
          corrections.signalWeights[sig.signal] = 1.2; // boost reliable important signals
        } else if (sig.reliability < 0.4 || sig.importance < 0.02) {
          corrections.signalWeights[sig.signal] = 0.5; // dampen unreliable/unimportant
        }
      }
    }

    // ── Regime adjustments ──
    if (results.regimePerformance) {
      for (const [regime, stats] of Object.entries(results.regimePerformance)) {
        if (stats.sampleSize >= 10) {
          if (stats.winRate < 0.35) {
            corrections.regimeAdjustments[regime] = { action: 'reduce', factor: 0.7 };
          } else if (stats.winRate > 0.60) {
            corrections.regimeAdjustments[regime] = { action: 'boost', factor: 1.2 };
          }
        }
      }
    }

    // ── Quality threshold updates ──
    if (results.qualityCalibration) {
      for (const [factor, stats] of Object.entries(results.qualityCalibration)) {
        if (stats.presentSample >= 5 && stats.absentSample >= 5) {
          corrections.qualityThresholds[factor] = {
            useful: stats.useful,
            lift: Math.round((stats.presenceWinRate - stats.absenceWinRate) * 1000) / 1000,
          };
        }
      }
    }

    // ── Overconfidence check ──
    if (results.hourlyStats) {
      const totalCorrect = Object.values(results.hourlyStats).reduce((s, h) => s + (h.correct || 0), 0);
      const totalAll = Object.values(results.hourlyStats).reduce((s, h) => s + (h.total || 0), 0);
      const overallWinRate = totalAll > 0 ? totalCorrect / totalAll : 0.5;

      if (overallWinRate < 0.45) corrections.confidenceMultiplier = 0.85;
      else if (overallWinRate > 0.60) corrections.confidenceMultiplier = 1.1;
      else corrections.confidenceMultiplier = 1.0;
    }

    // ── Direction bias ──
    if (results.hourlyStats) {
      let upWins = 0, upTotal = 0, downWins = 0, downTotal = 0;
      // Use prediction snapshots data indirectly through regime data
      const snapHourly = results.hourlyStats;
      for (const stats of Object.values(snapHourly)) {
        // We track bestDirection per hour but need aggregate direction bias
        // Use overall correct/total as proxy
        upTotal += stats.total;
      }
      // If we have regime data with direction info, use that
      if (results.regimePerformance) {
        // Not directly available per-direction from regime, use Kelly data
      }
    }

    // ── Kelly calibration feedback ──
    if (results.kellyAccuracy) {
      const ka = results.kellyAccuracy;
      // If kelly_has_edge doesn't actually predict wins, flag it
      if (ka.edgeSample >= 10 && ka.kellyCalibration < 0.02) {
        corrections.kellyUnderpowered = true;
      }
      if (ka.edgeSample >= 10 && ka.kellyEdgeWinRate < 0.45) {
        corrections.kellyMiscalibrated = true;
      }
    }

    return corrections;
  }

  // ── Accessors for other modules ────────────────────────────

  /** Get corrections for use by prediction engine */
  getCorrections() {
    return this.analysisResults?.corrections || null;
  }

  /** Get signal weight adjustments */
  getSignalWeights() {
    return this.analysisResults?.corrections?.signalWeights || null;
  }

  /** Get regime adjustments */
  getRegimeAdjustments() {
    return this.analysisResults?.corrections?.regimeAdjustments || null;
  }

  // ── Scheduling ─────────────────────────────────────────────

  /** Schedule to run at midnight UTC, and also run once on startup */
  scheduleNightly() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    const msUntilMidnight = midnight - now;

    // Run on startup with 30-second delay to let DB connect
    setTimeout(() => {
      console.log('[daily-learning] Running startup analysis (30s after boot)...');
      this.runDailyAnalysis().catch(e =>
        console.error('[daily-learning] Startup analysis failed:', e.message)
      );
    }, 30000);

    // Schedule nightly at midnight UTC
    setTimeout(() => {
      this.runDailyAnalysis().catch(e =>
        console.error('[daily-learning] Nightly analysis failed:', e.message)
      );
      // Then run every 24 hours
      setInterval(() => {
        this.runDailyAnalysis().catch(e =>
          console.error('[daily-learning] Nightly analysis failed:', e.message)
        );
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);

    console.log(`[daily-learning] Scheduled: startup in 30s, nightly in ${Math.round(msUntilMidnight / 60000)} minutes`);
  }

  // ── Dashboard summary ──────────────────────────────────────

  /** Get a summary for the dashboard */
  getSummary() {
    if (!this.analysisResults?.corrections) return null;
    const r = this.analysisResults;
    return {
      lastRun: this.lastRunDate,
      topSignals: (r.signalRanking || []).slice(0, 5),
      worstHours: Object.entries(r.hourlyStats || {})
        .filter(([_, s]) => s.winRate < 0.4 && s.total >= 5)
        .map(([h, s]) => ({ hour: parseInt(h, 10), winRate: s.winRate, total: s.total })),
      bestHours: Object.entries(r.hourlyStats || {})
        .filter(([_, s]) => s.winRate > 0.55 && s.total >= 5)
        .map(([h, s]) => ({ hour: parseInt(h, 10), winRate: s.winRate, total: s.total })),
      confidenceMultiplier: r.corrections.confidenceMultiplier,
      kellyAccuracy: r.kellyAccuracy || null,
      strategyBreakdown: r.strategyPerformance || {},
      regimePerformance: r.regimePerformance || {},
      qualityFactors: r.qualityCalibration || {},
    };
  }
}

module.exports = new DailyLearning();
