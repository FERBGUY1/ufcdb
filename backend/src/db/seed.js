require('dotenv').config();
const supabase = require('./client');

const WEIGHT_CLASSES = [
  { name:"Heavyweight",             slug:"heavyweight",             gender:"male",   limit_lbs:265, sort_order:1  },
  { name:"Light Heavyweight",       slug:"light-heavyweight",       gender:"male",   limit_lbs:205, sort_order:2  },
  { name:"Middleweight",            slug:"middleweight",            gender:"male",   limit_lbs:185, sort_order:3  },
  { name:"Welterweight",            slug:"welterweight",            gender:"male",   limit_lbs:170, sort_order:4  },
  { name:"Lightweight",             slug:"lightweight",             gender:"male",   limit_lbs:155, sort_order:5  },
  { name:"Featherweight",           slug:"featherweight",           gender:"male",   limit_lbs:145, sort_order:6  },
  { name:"Bantamweight",            slug:"bantamweight",            gender:"male",   limit_lbs:135, sort_order:7  },
  { name:"Flyweight",               slug:"flyweight",               gender:"male",   limit_lbs:125, sort_order:8  },
  { name:"Women's Strawweight",     slug:"womens-strawweight",      gender:"female", limit_lbs:115, sort_order:9  },
  { name:"Women's Flyweight",       slug:"womens-flyweight",        gender:"female", limit_lbs:125, sort_order:10 },
  { name:"Women's Bantamweight",    slug:"womens-bantamweight",     gender:"female", limit_lbs:135, sort_order:11 },
  { name:"Women's Featherweight",   slug:"womens-featherweight",    gender:"female", limit_lbs:145, sort_order:12 },
  { name:"Catch Weight",            slug:"catch-weight",            gender:"male",   limit_lbs:null,sort_order:13 },
  { name:"Super Heavyweight",       slug:"super-heavyweight",       gender:"male",   limit_lbs:null,sort_order:14 },
];

const PROMOTIONS = [
  { name:"UFC",              slug:"ufc",              country:"USA",   active:true,  founded:1993 },
  { name:"Bellator MMA",     slug:"bellator",         country:"USA",   active:true,  founded:2008 },
  { name:"ONE Championship", slug:"one-championship", country:"SGP",   active:true,  founded:2011 },
  { name:"PFL",              slug:"pfl",              country:"USA",   active:true,  founded:2018 },
  { name:"Pride FC",         slug:"pride-fc",         country:"JPN",   active:false, founded:1997 },
  { name:"Strikeforce",      slug:"strikeforce",      country:"USA",   active:false, founded:2006 },
  { name:"WEC",              slug:"wec",              country:"USA",   active:false, founded:2001 },
  { name:"DREAM",            slug:"dream",            country:"JPN",   active:false, founded:2008 },
  { name:"Invicta FC",       slug:"invicta-fc",       country:"USA",   active:true,  founded:2012 },
  { name:"RIZIN",            slug:"rizin",            country:"JPN",   active:true,  founded:2015 },
  { name:"KSW",              slug:"ksw",              country:"POL",   active:true,  founded:2004 },
  { name:"ACB",              slug:"acb",              country:"RUS",   active:true,  founded:2012 },
  { name:"LFA",              slug:"lfa",              country:"USA",   active:true,  founded:2017 },
  { name:"Regional/Other",   slug:"regional",         country:null,    active:true,  founded:null },
];

const FIGHTING_STYLES = [
  'Boxer', 'Kickboxer', 'Muay Thai', 'Karate', 'Taekwondo',
  'Wrestler (Collegiate)', 'Wrestler (Freestyle)', 'Wrestler (Greco-Roman)',
  'Sambo', 'Judo', 'BJJ Specialist', 'Grappler',
  'Pressure Fighter', 'Counter Striker', 'Dirty Boxer',
  'Clinch Fighter', 'Submission Hunter', 'Switch Hitter', 'All-Rounder'
];

async function seed() {
  console.log('Seeding weight classes...');
  const { error: wcErr } = await supabase
    .from('weight_classes')
    .upsert(WEIGHT_CLASSES, { onConflict: 'slug' });
  if (wcErr) { console.error(wcErr.message); process.exit(1); }
  console.log(`✓ ${WEIGHT_CLASSES.length} weight classes`);

  console.log('Seeding promotions...');
  const { error: promoErr } = await supabase
    .from('promotions')
    .upsert(PROMOTIONS, { onConflict: 'slug' });
  if (promoErr) { console.error(promoErr.message); process.exit(1); }
  console.log(`✓ ${PROMOTIONS.length} promotions`);

  console.log('\nAvailable fighting styles:');
  FIGHTING_STYLES.forEach(s => console.log(`  - ${s}`));
  console.log('\nSeed complete!');
}

seed().catch(console.error);
