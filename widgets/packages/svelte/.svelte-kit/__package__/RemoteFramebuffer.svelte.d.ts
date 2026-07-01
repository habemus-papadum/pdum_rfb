import { type Snippet } from "svelte";
import { type RfbSvelteOptions } from "./createRemoteFramebuffer";
type Props = RfbSvelteOptions & {
    class?: string;
    toolbar?: boolean;
    hud?: boolean;
    status?: boolean;
    badge?: boolean;
    children?: Snippet;
};
declare const RemoteFramebuffer: import("svelte").Component<Props, {}, "">;
type RemoteFramebuffer = ReturnType<typeof RemoteFramebuffer>;
export default RemoteFramebuffer;
