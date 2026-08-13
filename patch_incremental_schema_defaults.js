const fs = require('fs');
let schema = fs.readFileSync('prisma/schema.prisma', 'utf8');

schema = schema.replace(
  /data_extraction_prompt           String/g,
  'data_extraction_prompt           String @default("")'
);

schema = schema.replace(
  /html_template_prompt             String/g,
  'html_template_prompt             String @default("")'
);

fs.writeFileSync('prisma/schema.prisma', schema);
