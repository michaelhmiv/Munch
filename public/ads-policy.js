export function shouldShowAndroidBanner({
    route,
    pathname,
    dialogOpen,
    adFree,
}) {
    return (
        route === "more" &&
        pathname === "/app/more" &&
        dialogOpen !== true &&
        adFree === false
    );
}
