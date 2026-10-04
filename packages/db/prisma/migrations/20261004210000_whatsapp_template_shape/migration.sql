-- AlterTable
ALTER TABLE "whatsapp_message_templates" ADD COLUMN     "parameter_format" TEXT NOT NULL DEFAULT 'POSITIONAL',
ADD COLUMN     "parameters" TEXT[] DEFAULT ARRAY[]::TEXT[];


-- The provider's two parameter formats are not interchangeable: a positional template's values travel in
-- order and unnamed, a named template's each carry a `parameter_name`, and a send in the wrong shape is
-- refused. So the format is a stored fact rather than something inferred at dispatch, and the only two
-- values it may hold are written down here (Issue #20).
ALTER TABLE "whatsapp_message_templates" ADD CONSTRAINT "whatsapp_message_templates_parameter_format_check" CHECK (
  "parameter_format" IN ('POSITIONAL', 'NAMED')
);

-- Not expressible here: "a positional template's placeholders are exactly 1..N in order". It needs a
-- subquery and PostgreSQL forbids one in a CHECK, and an IMMUTABLE helper function would be more schema
-- machinery than this invariant is worth. It is parsed once at sync by `readTemplateShape`, which has its
-- own tests, and a shape that drifted is caught before dispatch by the variable validation rather than by
-- sending the wrong value into the wrong hole.

-- A placeholder with no name is a hole nothing can fill.
ALTER TABLE "whatsapp_message_templates" ADD CONSTRAINT "whatsapp_message_templates_parameter_names_check" CHECK (
  NOT ('' = ANY("parameters"))
);
