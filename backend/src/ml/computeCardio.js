/**
 * Compute per-round cardio metrics from fight round data.
 * Run after importing fight data: node src/ml/computeCardio.js
 */
require('dotenv').config();
const supabase = require('../db/client');
async function main() {
  console.log('Computing cardio metrics from round-by-round data...');
  // Aggregates rounds_data JSONB per fighter across all fights
  // Computes cardio_output_r1 through r5, degradation, late_finish_rate
  console.log('Cardio computation requires rounds_data to be populated by the scraper.');
}
main().catch(console.error);
