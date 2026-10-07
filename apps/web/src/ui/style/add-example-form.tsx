/**
 * Adding a style example by hand (Issue #32).
 *
 * Its own component rather than markup inside the route, for the reason this screen has already learned
 * twice: a route component is the one thing a test in this app cannot call, and the controls that went
 * missing went missing *there*. The scope select is the case in point — the store has always supported a
 * Workspace-level example and the form sent no scope at all, so `scopeFrom` defaulted every example to
 * this profile and the Workspace layer was unreachable from the product.
 */
import type { Translator } from "@/i18n/translate";
import type { StyleTarget } from "@/server/style-actions";

export interface AddExampleFormProps {
  readonly t: Translator;
  readonly target: StyleTarget;
  readonly action: (formData: FormData) => Promise<void>;
}

export function AddExampleForm({ t, action }: AddExampleFormProps) {
  return (
    <form action={action} className="knowledge-editor" data-form="add-example">
      <label htmlFor="style-inbound">{t.t("style.exampleInbound")}</label>
      <textarea id="style-inbound" name="inbound" rows={2} required />

      <label htmlFor="style-outbound">{t.t("style.exampleOutbound")}</label>
      <textarea id="style-outbound" name="outbound" rows={3} required />

      {/* Which layer the example belongs to. Defaulted to this profile, because that is the narrower of
          the two and the one a mistake costs least: an example meant for one business that lands on the
          base voice changes how every other profile in the workspace sounds. */}
      <label htmlFor="style-example-scope">{t.t("style.exampleScope")}</label>
      <select id="style-example-scope" name="scope" defaultValue="BUSINESS_PROFILE">
        <option value="BUSINESS_PROFILE">{t.t("style.layerProfile")}</option>
        <option value="WORKSPACE">{t.t("style.layerWorkspace")}</option>
      </select>

      <button className="button primary" type="submit" data-action="add-example">
        {t.t("style.addExample")}
      </button>
    </form>
  );
}
