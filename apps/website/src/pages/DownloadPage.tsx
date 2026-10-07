import { DownloadHub } from '../components/DownloadHub';
import { InstallCommand } from '../components/InstallCommand';
import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { VerifyInstaller } from '../components/VerifyInstaller';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';
import { Island } from '../islands';

/**
 * /download
 *
 * The page behind the short links printed on physical and marketing surfaces —
 * the DMG's QR code goes to /appstore and /playstore (public/_redirects), and
 * "where do I get it?" in a reply gets this one URL instead of a per-platform
 * guess. The page's job is one click long, so the copy's job is to make it the
 * RIGHT click: DownloadHub redirects when detection is certain and only
 * highlights when it is not (see its docblock for the per-platform reasoning).
 *
 * The route ships in every website locale. Copy lives under
 * PAGE_PROSE.downloadPage so the normal overlay and per-route slice owners can
 * translate and bundle it exactly like every other public page.
 */
export function DownloadPage() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();
    const copy = PAGE_PROSE.downloadPage;

    return (
        <PageShell>
            <PageHeader
                eyebrow={PAGE_PROSE.downloadBadges.p0}
                title={copy.p0}
                standfirst={copy.p1}
            />

            <Prose data-section="download-hub">
                <P>{rich(copy.p2)}</P>
                <Island name="download-hub" component={DownloadHub} />
            </Prose>

            <Prose heading={copy.p15}>
                <P>{rich(copy.p16)}</P>
                <P>{rich(copy.p17)}</P>
                <P>{rich(copy.p18)}</P>
            </Prose>

            <Prose heading={copy.p3} data-section="download-cli">
                <P>{rich(copy.p4)}</P>
                {/* locationOf resolves the surrounding data-section, so the copy
                    event lands as location: 'download-cli' with no override. */}
                <Island name="install-command" component={InstallCommand} />
                <P>{rich(copy.p5)}</P>
                <VerifyInstaller />
            </Prose>
        </PageShell>
    );
}
