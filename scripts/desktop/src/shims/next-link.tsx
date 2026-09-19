import { forwardRef } from "react";
import { Link as RRLink } from "react-router-dom";
import type { ComponentPropsWithoutRef } from "react";

type Props = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
  replace?: boolean;
  prefetch?: boolean;
};

/** Drop-in for next/link — same `href` API, React Router under the hood. */
const Link = forwardRef<HTMLAnchorElement, Props>(function Link(
  { href, replace, prefetch: _prefetch, children, ...rest },
  ref,
) {
  const external =
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("aquin://");

  if (external) {
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <RRLink ref={ref} to={href} replace={replace} {...rest}>
      {children}
    </RRLink>
  );
});

export default Link;
