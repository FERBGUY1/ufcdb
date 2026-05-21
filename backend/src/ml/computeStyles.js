/**
 * Compute style matchup statistics.
 * Run after importing fight data: node src/ml/computeStyles.js
 */
require('dotenv').config();
const { computeStyleMatchups } = require('./qualityEngine');
computeStyleMatchups().then(() => console.log('Done')).catch(console.error);
