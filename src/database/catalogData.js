/**
 * initialCatalog
 * --------------
 * Default Firebase seed catalog for the material app.
 *
 * This file intentionally uses small generator helpers instead of writing every
 * size variation by hand. The app still receives a normal array of material
 * objects, but the source file stays easier to maintain when a material family
 * must exist in every trade size from 1/2 inch through 4 inches.
 *
 * Important structure rules:
 * - name: base material name only, without the size typed into the name.
 * - size: selected trade size, displayed by the UI after the name.
 * - category: group used by search, filters, and unit defaults.
 * - keywords: extra search words. For example, searching "pipe" can find
 *   conduit records even when the visible name says "Conduit".
 *
 * WHERE TO ADD MORE SEARCH KEYWORDS:
 * Add more words inside the `keywords` array of the material family below.
 * Example: keywords: ['wire', 'conductor', 'cable', 'THHN # 12', 'A/C']
 * The search screen reads these keywords automatically, so you do not need
 * to change CatalogScreen when adding new search terms.
 * - imageUri: intentionally blank. Real photos should be captured with the
 *   camera/gallery and saved to Firebase by the app. No external image URLs are
 *   included so the catalog remains safe, portable, and owned by the project.
 */

const TRADE_SIZES = [
  '1/2"',
  '3/4"',
  '1"',
  '1 1/4"',
  '1 1/2"',
  '2"',
  '2 1/2"',
  '3"',
  '3 1/2"',
  '4"'
];

const WIRE_GAUGES = ['#12', '#10', '#14', '#16'];

const WIRE_COLORS = [
  'Black',
  'Red',
  'Blue',
  'Orange',
  'Brown',
  'Yellow',
  'White',
  'Green',
  'Gray',
  'Purple'
];

const createMaterial = ({
  name,
  category = 'Others',
  size = 'N/A',
  description = '',
  keywords = [],
  allowedUnits,
  familyName = '',
  color = ''
}) => ({
  name,
  category,
  size,
  description,
  keywords,
  imageUri: '',
  ...(familyName ? { familyName } : {}),
  ...(color ? { color } : {}),
  ...(allowedUnits ? { allowedUnits } : {})
});

const createSizedFamily = ({ name, category, description, keywords = [], allowedUnits }) => (
  TRADE_SIZES.map((size) => createMaterial({ name, category, size, description, keywords, allowedUnits, familyName: name }))
);

const createWireFamily = ({ type, gauge }) => {
  const gaugeNumber = gauge.replace('#', '').trim();

  // Extra wire keywords are centralized here. Add more terms to this array
  // when the field team uses another common nickname for this wire family.
  // Example: adding 'control wire' here will make every color of this gauge searchable by that phrase.
  const wireSearchKeywords = [
    'wire',
    'conductor',
    'cable',
    type.toLowerCase(),
    `${type} ${gauge}`.toLowerCase(),
    `${type} # ${gaugeNumber}`.toLowerCase(),
    `${type} number ${gaugeNumber}`.toLowerCase(),
    gauge.toLowerCase(),
    `# ${gaugeNumber}`,
    `gauge ${gaugeNumber}`
  ];

  // A/C is commonly used in the field for smaller thermostat/control wires.
  // Keeping it here allows a search like "A/C" or "AC" to find #14 and #16 wires.
  const acControlKeywords = ['#14', '#16'].includes(gauge)
    ? ['a/c', 'ac', 'air conditioning', 'thermostat', 'lead lag', 'leadlag', 'control wire']
    : [];

  return WIRE_COLORS.map((color) => createMaterial({
    name: `${type} Wire ${gauge} ${color}`,
    category: 'Conductors',
    size: 'N/A',
    description: `${type} building wire, ${gauge}, ${color.toLowerCase()} insulation.`,
    keywords: [...wireSearchKeywords, ...acControlKeywords, color.toLowerCase()],
    allowedUnits: ['Unit', 'Reel', 'Length (ft)'],
    familyName: `${type} Wire ${gauge}`,
    color
  }));
};

const sizedCatalogFamilies = [
  {
    name: 'EMT Conduit',
    category: 'Conduits',
    description: 'Electrical metallic tubing used as a raceway for conductors.',
    keywords: ['emt', 'conduit', 'pipe', 'tube', 'raceway', 'metal pipe'],
    allowedUnits: ['Unit', 'Bundle']
  },
  {
    name: 'Rigid Conduit',
    category: 'Conduits',
    description: 'Rigid metal conduit for stronger raceway installations.',
    keywords: ['rigid', 'ridgid', 'conduit', 'pipe', 'raceway', 'metal pipe'],
    allowedUnits: ['Unit', 'Bundle']
  },
  {
    name: 'Sealtite Pipe',
    category: 'Conduits',
    description: 'Flexible liquid-tight conduit used where movement or moisture protection is needed.',
    keywords: ['sealtite', 'seal tight', 'liquid tight', 'flex', 'flexible conduit', 'pipe', 'conduit'],
    allowedUnits: ['Unit', 'Bundle']
  },
  {
    name: 'EMT Coupling',
    category: 'Connectors',
    description: 'Coupling used to join two pieces of EMT conduit.',
    keywords: ['emt', 'coupling', 'connector', 'joiner', 'conduit fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Rigid Coupling',
    category: 'Connectors',
    description: 'Coupling used to join two pieces of rigid conduit.',
    keywords: ['rigid', 'ridgid', 'coupling', 'connector', 'joiner', 'conduit fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'EMT Connector',
    category: 'Connectors',
    description: 'Connector used to terminate EMT conduit into a box or enclosure.',
    keywords: ['emt', 'connector', 'coupling', 'fitting', 'conduit connector'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Rigid Connector',
    category: 'Connectors',
    description: 'Connector used to terminate rigid conduit into a box or enclosure.',
    keywords: ['rigid', 'ridgid', 'connector', 'fitting', 'conduit connector'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Sealtite Straight Connector',
    category: 'Connectors',
    description: 'Straight liquid-tight connector for sealtite conduit.',
    keywords: ['sealtite', 'seal tight', 'liquid tight', 'straight connector', 'connector', 'fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Sealtite 90 Degree Connector',
    category: 'Connectors',
    description: 'Ninety-degree liquid-tight connector for sealtite conduit.',
    keywords: ['sealtite', 'seal tight', 'liquid tight', '90', '90 degree', 'ninety', 'connector', 'fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Plastic Bushing',
    category: 'Fittings',
    description: 'Plastic bushing used to protect conductors at conduit ends.',
    keywords: ['plastic', 'bushing', 'protector', 'conduit end', 'fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Grounding Bushing',
    category: 'Fittings',
    description: 'Grounding bushing used for bonding raceways and protecting conductors.',
    keywords: ['grounding', 'ground', 'bonding', 'bushing', 'fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'White Cap',
    category: 'Fittings',
    description: 'White cap used to protect or finish conduit openings.',
    keywords: ['white cap', 'cap', 'cover', 'plug', 'conduit cap'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Nipple',
    category: 'Fittings',
    description: 'Short threaded conduit nipple used between boxes or fittings.',
    keywords: ['nipple', 'threaded nipple', 'rigid nipple', 'connector', 'fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Uni-Strut Clamp',
    category: 'Fittings',
    description: 'Clamp used to secure conduit to uni-strut channel.',
    keywords: ['unistrut', 'uni-strut', 'strut', 'clamp', 'pipe clamp', 'conduit clamp'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Stainless Steel Uni-Strut Clamp',
    category: 'Fittings',
    description: 'Stainless steel clamp used to secure conduit to uni-strut channel.',
    keywords: ['stainless', 'stainless steel', 'unistrut', 'uni-strut', 'strut', 'clamp', 'pipe clamp'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Stand Strap',
    category: 'Fittings',
    description: 'Stand strap used to secure conduit to a surface.',
    keywords: ['stand strap', 'strap', 'conduit strap', 'pipe strap', 'support'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Stainless Steel Stand Strap',
    category: 'Fittings',
    description: 'Stainless steel stand strap used to secure conduit in corrosive or exposed areas.',
    keywords: ['stainless', 'stainless steel', 'stand strap', 'strap', 'conduit strap', 'pipe strap'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Plastic LB',
    category: 'Fittings',
    description: 'Plastic LB conduit body used for pulls and directional changes.',
    keywords: ['plastic', 'lb', 'conduit body', 'pull body', 'access fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Galvanized LB',
    category: 'Fittings',
    description: 'Galvanized LB conduit body used for pulls and directional changes.',
    keywords: ['galvanized', 'galvanised', 'metal', 'lb', 'conduit body', 'pull body'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Plastic LL',
    category: 'Fittings',
    description: 'Plastic LL conduit body used for left-side access pulls.',
    keywords: ['plastic', 'll', 'conduit body', 'pull body', 'access fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Galvanized LL',
    category: 'Fittings',
    description: 'Galvanized LL conduit body used for left-side access pulls.',
    keywords: ['galvanized', 'galvanised', 'metal', 'll', 'conduit body', 'pull body'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Plastic LR',
    category: 'Fittings',
    description: 'Plastic LR conduit body used for right-side access pulls.',
    keywords: ['plastic', 'lr', 'conduit body', 'pull body', 'access fitting'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Galvanized LR',
    category: 'Fittings',
    description: 'Galvanized LR conduit body used for right-side access pulls.',
    keywords: ['galvanized', 'galvanised', 'metal', 'lr', 'conduit body', 'pull body'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Plastic T-Shaped Conduit Body',
    category: 'Fittings',
    description: 'Plastic T-shaped conduit body used for branch conduit runs.',
    keywords: ['plastic', 't-shaped', 't shaped', 'tee', 'conduit body', 'pull body'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Galvanized T-Shaped Conduit Body',
    category: 'Fittings',
    description: 'Galvanized T-shaped conduit body used for branch conduit runs.',
    keywords: ['galvanized', 'galvanised', 'metal', 't-shaped', 't shaped', 'tee', 'conduit body'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Plastic C-Shaped Conduit Body',
    category: 'Fittings',
    description: 'Plastic C-shaped conduit body used for straight access conduit pulls.',
    keywords: ['plastic', 'c-shaped', 'c shaped', 'conduit body', 'pull body'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Galvanized C-Shaped Conduit Body',
    category: 'Fittings',
    description: 'Galvanized C-shaped conduit body used for straight access conduit pulls.',
    keywords: ['galvanized', 'galvanised', 'metal', 'c-shaped', 'c shaped', 'conduit body'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Plastic X-Shaped Conduit Body',
    category: 'Fittings',
    description: 'Plastic X-shaped conduit body used for multiple-direction conduit access.',
    keywords: ['plastic', 'x-shaped', 'x shaped', 'cross', 'conduit body', 'pull body'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  },
  {
    name: 'Galvanized X-Shaped Conduit Body',
    category: 'Fittings',
    description: 'Galvanized X-shaped conduit body used for multiple-direction conduit access.',
    keywords: ['galvanized', 'galvanised', 'metal', 'x-shaped', 'x shaped', 'cross', 'conduit body'],
    allowedUnits: ['Unit', 'Box', 'Bundle']
  }
];

const deviceCatalog = [
  createMaterial({ name: 'Double Receptacle', category: 'Devices', description: 'Duplex electrical receptacle.', keywords: ['receptacle', 'outlet', 'device', 'duplex'], allowedUnits: ['Unit', 'Box'] }),
  createMaterial({ name: 'Single Switch', category: 'Devices', description: 'Single-pole wall switch.', keywords: ['switch', 'device', 'single pole'], allowedUnits: ['Unit', 'Box'] }),
  createMaterial({ name: 'Three Way Switch', category: 'Devices', description: 'Three-way wall switch.', keywords: ['three way', '3 way', 'switch', 'device'], allowedUnits: ['Unit', 'Box'] }),
  createMaterial({ name: 'Wall Switch Plate 1-Gang', category: 'Devices', description: 'One-gang switch wall plate.', keywords: ['plate', 'wall plate', 'switch plate', 'cover'], allowedUnits: ['Unit', 'Box'] }),
  createMaterial({ name: 'Wall Receptacle Plate 1-Gang', category: 'Devices', description: 'One-gang receptacle wall plate.', keywords: ['plate', 'wall plate', 'receptacle plate', 'cover'], allowedUnits: ['Unit', 'Box'] }),
  createMaterial({ name: 'Exterior Receptacle Plate 1-Gang', category: 'Devices', description: 'Exterior rated receptacle cover plate.', keywords: ['exterior', 'weatherproof', 'plate', 'cover', 'receptacle'], allowedUnits: ['Unit', 'Box'] }),
  createMaterial({ name: 'Exterior Light', category: 'Devices', description: 'Exterior lighting device.', keywords: ['light', 'fixture', 'exterior', 'device'], allowedUnits: ['Unit', 'Box'] })
];

const boxCatalog = [
  createMaterial({ name: '4x4 Galvanized Box', category: 'Boxes', description: 'Four-inch square galvanized electrical box.', keywords: ['box', 'junction box', '4x4', 'galvanized'], allowedUnits: ['Unit', 'Box', 'Bundle'] }),
  createMaterial({ name: '2x4 Galvanized Box', category: 'Boxes', description: 'Two-by-four galvanized electrical device box.', keywords: ['box', 'device box', '2x4', 'galvanized'], allowedUnits: ['Unit', 'Box', 'Bundle'] }),
  createMaterial({ name: 'Round PVC Box', category: 'Boxes', description: 'Round PVC electrical box.', keywords: ['box', 'round box', 'pvc box', 'junction box'], allowedUnits: ['Unit', 'Box', 'Bundle'] })
];

const drillBitCatalog = [
  createMaterial({ name: 'Drill Bit', category: 'Tools', size: '1/8"', description: 'General small pilot drill bit.', keywords: ['drill', 'bit', 'tool', 'replacement tool'], allowedUnits: ['Unit', 'Box'], familyName: 'Drill Bit' }),
  createMaterial({ name: 'Drill Bit', category: 'Tools', size: '7/32"', description: 'Common drill size used before tapping 1/4 inch threads.', keywords: ['drill', 'bit', 'tap', '1/4 tap', 'tool'], allowedUnits: ['Unit', 'Box'], familyName: 'Drill Bit' }),
  createMaterial({ name: 'Drill Bit', category: 'Tools', size: '5/16"', description: 'Common drill size used before tapping 3/8 inch threads.', keywords: ['drill', 'bit', 'tap', '3/8 tap', 'tool'], allowedUnits: ['Unit', 'Box'], familyName: 'Drill Bit' }),
  createMaterial({ name: 'Drill Bit', category: 'Tools', size: '3/8"', description: 'General purpose drill bit for field installation work.', keywords: ['drill', 'bit', 'tool', 'replacement tool'], allowedUnits: ['Unit', 'Box'], familyName: 'Drill Bit' })
];

const toolCatalog = [
  createMaterial({ name: 'Band Saw Blade', category: 'Tools', description: 'Replacement band saw blade.', keywords: ['bandsaw', 'band saw', 'blade', 'tool', 'replacement tool'], allowedUnits: ['Unit', 'Box'] }),
  ...drillBitCatalog,
  createMaterial({ name: 'Tap and Drill Bit Set', category: 'Tools', description: 'Tap and drill bit set for threaded holes.', keywords: ['tap', 'drill', 'bit', 'set', 'tool', 'replacement tool'], allowedUnits: ['Unit', 'Box'] })
];

const otherCatalog = [
  createMaterial({ name: 'Stainless Steel Uni-Strut', category: 'Others', description: 'Stainless steel strut channel for supporting conduit and equipment.', keywords: ['unistrut', 'uni-strut', 'strut', 'channel', 'stainless steel'], allowedUnits: ['Unit', 'Bundle'] }),
  createMaterial({ name: 'Galvanized Uni-Strut', category: 'Others', description: 'Galvanized strut channel for supporting conduit and equipment.', keywords: ['unistrut', 'uni-strut', 'strut', 'channel', 'galvanized'], allowedUnits: ['Unit', 'Bundle'] }),
  createMaterial({ name: 'UTP Cable', category: 'Conductors', size: 'Cat6', description: '', keywords: ['utp', 'cat6', 'network', 'data cable', 'ethernet', 'wire'], allowedUnits: ['Unit', 'Reel', 'Length (ft)'], familyName: 'UTP Cable' }),
  createMaterial({ name: 'UTP Cable', category: 'Conductors', size: 'Cat5', description: '', keywords: ['utp', 'cat5', 'network', 'data cable', 'ethernet', 'wire'], allowedUnits: ['Unit', 'Reel', 'Length (ft)'], familyName: 'UTP Cable' })
];

export const initialCatalog = [
  ...sizedCatalogFamilies.flatMap(createSizedFamily),
  ...WIRE_GAUGES.flatMap((gauge) => createWireFamily({ type: 'THHN', gauge })),
  ...WIRE_GAUGES.flatMap((gauge) => createWireFamily({ type: 'XHHW', gauge })),
  ...deviceCatalog,
  ...boxCatalog,
  ...toolCatalog,
  ...otherCatalog
];
