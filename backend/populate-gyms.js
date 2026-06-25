/**
 * populate-gyms.js
 *
 * Inserts records for the top UFC training gyms (with official websites),
 * then links fighters to their gym via gym_id by matching the gym_name field.
 *
 * Run: node -r dotenv/config populate-gyms.js [--dry-run]
 */
require('dotenv').config();
const supabase = require('./src/db/client');

const DRY = process.argv.includes('--dry-run');

// Gyms to insert. gym_name_variants = all values of fighters.gym_name that map to this gym.
const GYMS = [
  {
    name: 'American Top Team',
    slug: 'american-top-team',
    city: 'Coconut Creek', state: 'FL', country: 'United States',
    website: 'https://americantopteam.com',
    gym_name_variants: ['American Top Team'],
  },
  {
    name: 'American Kickboxing Academy',
    slug: 'american-kickboxing-academy',
    city: 'San Jose', state: 'CA', country: 'United States',
    website: 'https://theaka.com',
    gym_name_variants: ['American Kickboxing Academy'],
  },
  {
    name: 'Jackson-Wink MMA',
    slug: 'jackson-wink-mma',
    city: 'Albuquerque', state: 'NM', country: 'United States',
    website: 'https://jacksonwink.com',
    gym_name_variants: ['Jackson-Wink MMA', 'Jackson Wink MMA', 'Jackson-Wink'],
  },
  {
    name: 'Team Alpha Male',
    slug: 'team-alpha-male',
    city: 'Sacramento', state: 'CA', country: 'United States',
    website: 'https://teamalphamale.com',
    gym_name_variants: ['Team Alpha Male'],
  },
  {
    name: 'Xtreme Couture',
    slug: 'xtreme-couture',
    city: 'Las Vegas', state: 'NV', country: 'United States',
    website: 'https://xtremecouture.tv',
    gym_name_variants: ['Xtreme Couture'],
  },
  {
    name: 'Kill Cliff FC',
    slug: 'kill-cliff-fc',
    city: 'Atlanta', state: 'GA', country: 'United States',
    website: 'https://killclifffc.com',
    gym_name_variants: ['Kill Cliff FC', 'Kill Cliff'],
  },
  {
    name: 'Nova Uniao',
    slug: 'nova-uniao',
    city: 'Rio de Janeiro', state: 'RJ', country: 'Brazil',
    website: 'https://novauniao.com.br',
    gym_name_variants: ['Nova Uniao'],
  },
  {
    name: 'Syndicate MMA',
    slug: 'syndicate-mma',
    city: 'Las Vegas', state: 'NV', country: 'United States',
    website: 'https://syndicatemma.com',
    gym_name_variants: ['Syndicate MMA'],
  },
  {
    name: 'Elevation Fight Team',
    slug: 'elevation-fight-team',
    city: 'Denver', state: 'CO', country: 'United States',
    website: 'https://elevationfightteam.com',
    gym_name_variants: ['Elevation Fight Team'],
  },
  {
    name: 'MMA Lab',
    slug: 'mma-lab',
    city: 'Glendale', state: 'AZ', country: 'United States',
    website: 'https://themmalab.com',
    gym_name_variants: ['MMA Lab'],
  },
  {
    name: 'Alliance MMA',
    slug: 'alliance-mma',
    city: 'Chula Vista', state: 'CA', country: 'United States',
    website: 'https://alliancemma.com',
    gym_name_variants: ['Alliance MMA'],
  },
  {
    name: 'Factory X',
    slug: 'factory-x',
    city: 'Denver', state: 'CO', country: 'United States',
    website: null,
    gym_name_variants: ['Factory X'],
  },
  {
    name: 'Tristar Gym',
    slug: 'tristar-gym',
    city: 'Montreal', state: 'QC', country: 'Canada',
    website: 'https://tristargym.com',
    gym_name_variants: ['Tristar Gym', 'Tristar'],
  },
  {
    name: 'Fortis MMA',
    slug: 'fortis-mma',
    city: 'Dallas', state: 'TX', country: 'United States',
    website: 'https://fortismma.com',
    gym_name_variants: ['Fortis MMA'],
  },
  {
    name: 'MMA Masters',
    slug: 'mma-masters',
    city: 'Miami', state: 'FL', country: 'United States',
    website: null,
    gym_name_variants: ['MMA Masters'],
  },
  {
    name: 'Tiger Muay Thai',
    slug: 'tiger-muay-thai',
    city: 'Phuket', state: null, country: 'Thailand',
    website: 'https://tigermuaythai.com',
    gym_name_variants: ['Tiger Muay Thai'],
  },
  {
    name: 'Kings MMA',
    slug: 'kings-mma',
    city: 'Huntington Beach', state: 'CA', country: 'United States',
    website: 'https://kingsmma.com',
    gym_name_variants: ['Kings MMA'],
  },
  {
    name: 'Roufusport',
    slug: 'roufusport',
    city: 'Milwaukee', state: 'WI', country: 'United States',
    website: 'https://roufusport.com',
    gym_name_variants: ['Roufusport'],
  },
  {
    name: 'Renzo Gracie Jiu-Jitsu',
    slug: 'renzo-gracie',
    city: 'New York', state: 'NY', country: 'United States',
    website: 'https://renzogracie.com',
    gym_name_variants: ['Renzo Gracie Jiu-Jitsu', 'Renzo Gracie'],
  },
  {
    name: 'Allstars Training Center',
    slug: 'allstars-training-center',
    city: 'Stockholm', state: null, country: 'Sweden',
    website: 'https://allstarsgym.se',
    gym_name_variants: ['Allstars Training Center', 'Allstars'],
  },
  {
    name: 'SBG Ireland',
    slug: 'sbg-ireland',
    city: 'Dublin', state: null, country: 'Ireland',
    website: 'https://sbgireland.com',
    gym_name_variants: ['SBG Ireland'],
  },
  {
    name: 'City Kickboxing',
    slug: 'city-kickboxing',
    city: 'Auckland', state: null, country: 'New Zealand',
    website: 'https://citykickboxing.com',
    gym_name_variants: ['City Kickboxing'],
  },
  {
    name: 'Team Quest',
    slug: 'team-quest',
    city: 'Gresham', state: 'OR', country: 'United States',
    website: null,
    gym_name_variants: ['Team Quest'],
  },
  {
    name: 'Black House MMA',
    slug: 'black-house',
    city: 'Los Angeles', state: 'CA', country: 'United States',
    website: null,
    gym_name_variants: ['Black House'],
  },
  {
    name: 'Grudge Training Center',
    slug: 'grudge-training-center',
    city: 'Denver', state: 'CO', country: 'United States',
    website: null,
    gym_name_variants: ['Grudge Training Center'],
  },
  {
    name: 'Reign MMA',
    slug: 'reign-mma',
    city: 'Las Vegas', state: 'NV', country: 'United States',
    website: null,
    gym_name_variants: ['Reign MMA'],
  },
  {
    name: 'Cesar Gracie Fight Team',
    slug: 'cesar-gracie-fight-team',
    city: 'Pleasant Hill', state: 'CA', country: 'United States',
    website: null,
    gym_name_variants: ['Cesar Gracie Fight Team', 'Cesar Gracie Jiu-Jitsu'],
  },
  {
    name: 'Serra-Longo Fight Team',
    slug: 'serra-longo',
    city: 'Sayville', state: 'NY', country: 'United States',
    website: null,
    gym_name_variants: ['Serra-Longo Fight Team'],
  },
  {
    name: "Finney's HIT Squad",
    slug: 'finneys-hit-squad',
    city: 'St. Louis', state: 'MO', country: 'United States',
    website: null,
    gym_name_variants: ["Finney's HIT Squad"],
  },
  {
    name: 'Fight Ready',
    slug: 'fight-ready',
    city: 'Scottsdale', state: 'AZ', country: 'United States',
    website: null,
    gym_name_variants: ['Fight Ready'],
  },
  {
    name: 'Glory MMA & Fitness',
    slug: 'glory-mma',
    city: 'Las Vegas', state: 'NV', country: 'United States',
    website: null,
    gym_name_variants: ['Glory MMA & Fitness'],
  },
  {
    name: "Lion's Den",
    slug: 'lions-den',
    city: null, state: null, country: 'United States',
    website: null,
    gym_name_variants: ["Lion's Den"],
  },
  {
    name: 'Miletich Martial Arts',
    slug: 'miletich-martial-arts',
    city: 'Bettendorf', state: 'IA', country: 'United States',
    website: null,
    gym_name_variants: ['Miletich Martial Arts'],
  },
  {
    name: 'Arizona Combat Sports',
    slug: 'arizona-combat-sports',
    city: 'Phoenix', state: 'AZ', country: 'United States',
    website: null,
    gym_name_variants: ['Arizona Combat Sports'],
  },
  {
    name: 'Millennia MMA',
    slug: 'millennia-mma',
    city: null, state: null, country: 'United States',
    website: null,
    gym_name_variants: ['Millennia MMA'],
  },
  {
    name: 'Team Nogueira',
    slug: 'team-nogueira',
    city: 'Rio de Janeiro', state: 'RJ', country: 'Brazil',
    website: null,
    gym_name_variants: ['Team Nogueira'],
  },
  {
    name: 'Team Oyama',
    slug: 'team-oyama',
    city: 'Los Angeles', state: 'CA', country: 'United States',
    website: null,
    gym_name_variants: ['Team Oyama'],
  },
  {
    name: 'Entram Gym',
    slug: 'entram-gym',
    city: null, state: null, country: 'Japan',
    website: null,
    gym_name_variants: ['Entram Gym'],
  },
];

async function main() {
  console.log(DRY ? '=== DRY RUN ===' : '=== POPULATING GYMS ===\n');

  let inserted = 0, skipped = 0, linked = 0;

  for (const gym of GYMS) {
    const { gym_name_variants, ...gymRecord } = gym;

    // Upsert gym by slug
    if (DRY) {
      console.log(`  DRY INSERT: "${gym.name}" (${gym.website || 'no website'})`);
    } else {
      const { data: existing } = await supabase.from('gyms').select('id').eq('slug', gym.slug).maybeSingle();

      let gymId;
      if (existing) {
        // Update with website if set
        const { error } = await supabase.from('gyms').update({
          name: gymRecord.name,
          city: gymRecord.city,
          state: gymRecord.state,
          country: gymRecord.country,
          website: gymRecord.website,
        }).eq('id', existing.id);
        if (error) { console.error(`  ERR update "${gym.name}": ${error.message}`); continue; }
        gymId = existing.id;
        skipped++;
      } else {
        const { data, error } = await supabase.from('gyms').insert(gymRecord).select('id').single();
        if (error) { console.error(`  ERR insert "${gym.name}": ${error.message}`); continue; }
        gymId = data.id;
        inserted++;
      }

      // Link fighters whose gym_name matches any variant
      for (const variant of gym_name_variants) {
        const { error: linkErr, count } = await supabase.from('fighters')
          .update({ gym_id: gymId })
          .eq('gym_name', variant)
          .is('gym_id', null);
        if (linkErr) console.error(`  ERR linking fighters for "${variant}": ${linkErr.message}`);
        else if (count > 0) { linked += count; }
      }

      // Count linked fighters for display
      const { count: total } = await supabase.from('fighters')
        .select('id', { count: 'exact', head: true })
        .eq('gym_id', gymId);
      console.log(`  ${existing ? 'UPDATED' : 'INSERTED'} "${gym.name}" (id: ${gymId.slice(0,8)}...) — ${total} fighters linked${gym.website ? ', website: ' + gym.website : ''}`);
    }
  }

  if (!DRY) {
    console.log(`\nDone. ${inserted} new gyms, ${skipped} updated, ~${linked} fighters newly linked.`);
    console.log('Note: fighters already having gym_id set were not re-linked.');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
