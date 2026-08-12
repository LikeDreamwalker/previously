"use client"

import { useEffect, useRef, type ComponentPropsWithoutRef } from "react"
import { useInView, useMotionValue, useSpring } from "motion/react"

import { cn } from "@/lib/utils"

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number
  /** The number the roll STARTS from. May be larger or smaller than `value` —
   *  the spring rolls forward (start → value) or reverse (value → start)
   *  automatically. */
  startValue?: number
  delay?: number
  decimalPlaces?: number
  /** Pad the integer part to at least this many digits (e.g. 2 → "09") */
  minIntegerDigits?: number
}

export function NumberTicker({
  value,
  startValue = 0,
  delay = 0,
  className,
  decimalPlaces = 0,
  minIntegerDigits,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const motionValue = useMotionValue(startValue)
  const springValue = useSpring(motionValue, {
    damping: 60,
    stiffness: 100,
  })
  const isInView = useInView(ref, { once: true, margin: "0px" })

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    if (isInView) {
      timer = setTimeout(() => {
        motionValue.set(value)
      }, delay * 1000)
    }

    return () => {
      if (timer !== null) {
        clearTimeout(timer)
      }
    }
  }, [motionValue, isInView, delay, value, startValue])

  useEffect(
    () =>
      springValue.on("change", (latest) => {
        if (ref.current) {
          ref.current.textContent = Intl.NumberFormat("en-US", {
            minimumFractionDigits: decimalPlaces,
            maximumFractionDigits: decimalPlaces,
            minimumIntegerDigits: minIntegerDigits ?? 1,
            useGrouping: false,
          }).format(Number(latest.toFixed(decimalPlaces)))
        }
      }),
    [springValue, decimalPlaces, minIntegerDigits]
  )

  return (
    <span
      ref={ref}
      className={cn(
        "inline-block tracking-wider font-mono text-black tabular-nums dark:text-white",
        className
      )}
      {...props}
    >
      {minIntegerDigits ? String(startValue).padStart(minIntegerDigits, "0") : startValue}
    </span>
  )
}
