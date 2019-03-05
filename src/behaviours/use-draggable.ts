import { RefObject, useContext, useMemo, useRef } from "react"
import { usePanGesture, PanInfo } from "../gestures"
import { createLock, Lock } from "./utils/lock"
import { MotionValuesMap } from "../motion/utils/use-motion-values"
import { MotionContext } from "../motion/context/MotionContext"
import { Point } from "../events"
import { MotionValue } from "../value"
import { mix } from "@popmotion/popcorn"
import { ComponentAnimationControls } from "../motion"

type DragDirection = "x" | "y"

export type Constraints = {
    left?: number
    right?: number
    top?: number
    bottom?: number
}

/**
 * @public
 */
export interface DraggableProps {
    /**
     * Enable dragging for this element. Set to `false` by default.
     *
     * @remarks
     * Set "x" or "y" to only drag in a specific direction
     * Set "lockDirection" to lock dragging into the initial direction
     *
     * ```jsx
     * function App() {
     *   return <motion.div dragEnabled="x" />
     * }
     * ```
     */
    dragEnabled?: boolean | "x" | "y" | "lockDirection"

    /**
     * Allows drag gesture propagation to child components. Set to `false` by
     * default.
     *
     * ```jsx
     * function App() {
     *   return <motion.div dragEnabled="x" dragPropagation />
     * }
     * ```
     */
    dragPropagation?: boolean

    /**
     * An object of optional `top`, `left`, `right`, `bottom` pixel values,
     * beyond which dragging is constrained
     *
     * ```jsx
     * function App() {
     *   return (
     *     <motion.div
     *       dragEnabled="x"
     *       dragConstraints={{ left: 0, right: 300 }}
     *     />
     *   )
     * }
     * ```
     */
    dragConstraints?:
        | false
        | { top?: number; right?: number; bottom?: number; left?: number }

    /**
     * The degree of movement allowed outside constraints. 0 = no movement, 1 =
     * full movement. Set to `0.5` by default.
     *
     * ```jsx
     * function App() {
     *   return (
     *     <motion.div
     *       dragEnabled
     *       dragConstraints={{ left: 0, right: 300 }}
     *       dragElastic={0.2}
     *     />
     *   )
     * }
     * ```
     */
    dragElastic?: boolean | number

    /**
     * Apply momentum from the pan gesture to the component when dragging
     * finishes. Set to `true` by default.
     *
     * ```jsx
     * function App() {
     *   return (
     *     <motion.div
     *       dragEnabled
     *       dragConstraints={{ left: 0, right: 300 }}
     *       dragMomentum={false}
     *     />
     *   )
     * }
     * ```
     */
    dragMomentum?: boolean

    /**
     * Callback that fires when dragging starts.
     *
     * ```jsx
     * function App() {
     *   const onDragStart = (event, { point, delta, offset, velocity }) => {
     *     console.log(`Dragging started at ${point.x} ${point.y}`)
     *   }
     *
     *   return <motion.div dragEnabled onDragStart={onDragStart} />
     * }
     * ```
     */
    onDragStart?(e: MouseEvent | TouchEvent): void

    /**
     * Callback that fires when dragging ends.
     *
     * ```jsx
     * function App() {
     *   const onDragEnd = (event, { point, delta, offset, velocity }) => {
     *     console.log(`Dragging ended at ${point.x} ${point.y}`)
     *   }
     *
     *   return <motion.div dragEnabled onDragEnd={onDragEnd} />
     * }
     * ```
     */
    onDragEnd?(e: MouseEvent | TouchEvent): void

    /**
     * Callback that fires when the component is dragged.
     *
     * ```jsx
     * function App() {
     *   const onDrag = (event, { point, delta, offset, velocity }) => {
     *     console.log(`Drag velocity is ${velocity.x} ${velocity.y}`)
     *   }
     *
     *   return <motion.div dragEnabled onDrag={onDrag} />
     * }
     * ```
     */
    onDrag?(e: MouseEvent | TouchEvent, info: PanInfo): void

    /**
     * Callback that fires a drag direction is determined.
     *
     * ```jsx
     * function App() {
     *   const onDirectionLock = (axis) => {
     *     console.log(`Dragging locked to the ${axis} axis`)
     *   }
     *
     *   return <motion.div dragEnabled onDirectionLock={onDirectionLock} />
     * }
     * ```
     */
    onDirectionLock?(axis: "x" | "y"): void
}

const flattenConstraints = (constraints: Constraints | false) => {
    if (!constraints) {
        return [0, 0, 0, 0]
    } else {
        const { top, left, bottom, right } = constraints
        return [top, left, bottom, right]
    }
}

function shouldDrag(
    direction: DragDirection,
    drag: boolean | DragDirection | "lockDirection",
    currentDirection: null | DragDirection
) {
    return (
        (drag === true || drag === "lockDirection" || drag === direction) &&
        (currentDirection === null || currentDirection === direction)
    )
}

const getConstraints = (
    axis: "x" | "y",
    { top, right, bottom, left }: Constraints
) => {
    if (axis === "x") {
        return { min: left, max: right }
    } else {
        return { min: top, max: bottom }
    }
}

const applyOverdrag = (
    origin: number,
    current: number,
    dragElastic: boolean | number
) => {
    const dragFactor = typeof dragElastic === "number" ? dragElastic : 0.5
    return mix(origin, current, dragFactor)
}

type MotionPoint = Partial<{
    x: MotionValue<number>
    y: MotionValue<number>
}>

/**
 * A hook that allows an element to be dragged.
 *
 * @internalremarks
 * TODO:
 * 1. Allow `dragMomentum` to accept richer properties that adjust this behaviour
 * 2. Allow a parent motion component to become the drag boundaries for a child
 *
 * @param param
 * @param ref
 * @param values
 * @param controls
 *
 * @internal
 */
export function useDraggable(
    {
        dragEnabled = false,
        dragPropagation = false,
        dragConstraints = false,
        dragElastic = true,
        dragMomentum = true,
        onDragStart,
        onDragEnd,
        onDrag,
        onDirectionLock,
    }: DraggableProps,
    ref: RefObject<Element | null>,
    values: MotionValuesMap,
    controls: ComponentAnimationControls
) {
    const point = useRef<MotionPoint>({}).current
    const origin = useRef({ x: 0, y: 0 }).current
    const motionContext = useContext(MotionContext)

    const handlers = useMemo(
        () => {
            if (!dragEnabled) return {}

            let currentDirection: null | DragDirection = null
            let openGlobalLock: null | Lock = null

            if (shouldDrag("x", dragEnabled, currentDirection)) {
                point.x = values.get("x", 0)
            }
            if (shouldDrag("y", dragEnabled, currentDirection)) {
                point.y = values.get("y", 0)
            }

            const updatePoint = (
                axis: "x" | "y",
                offset: { x: number; y: number }
            ) => {
                const p = point[axis]
                if (!shouldDrag(axis, dragEnabled, currentDirection) || !p)
                    return

                let current = origin[axis] + offset[axis]

                if (dragConstraints) {
                    const { min, max } = getConstraints(axis, dragConstraints)

                    if (min !== undefined && current < min) {
                        current = dragElastic
                            ? applyOverdrag(min, current, dragElastic)
                            : Math.max(min, current)
                    } else if (max !== undefined && current > max) {
                        current = dragElastic
                            ? applyOverdrag(max, current, dragElastic)
                            : Math.min(max, current)
                    }
                }

                p.set(current)
            }

            const onPanStart = (event: MouseEvent | TouchEvent) => {
                if (point.x) {
                    origin.x = point.x.get()
                    point.x.stop()
                }
                if (point.y) {
                    origin.y = point.y.get()
                    point.y.stop()
                }

                if (!dragPropagation) {
                    openGlobalLock = getGlobalLock(dragEnabled)

                    if (!openGlobalLock) {
                        return
                    }
                }
                currentDirection = null
                motionContext.dragging = true

                onDragStart && onDragStart(event)
            }

            const onPan = (event: MouseEvent | TouchEvent, info: PanInfo) => {
                if (!dragPropagation && !openGlobalLock) {
                    return
                }

                const { offset } = info

                if (dragEnabled === "lockDirection") {
                    if (currentDirection === null) {
                        currentDirection = getCurrentDirection(offset)

                        if (currentDirection !== null) {
                            onDirectionLock && onDirectionLock(currentDirection)
                        }
                        return
                    }
                }

                updatePoint("x", offset)
                updatePoint("y", offset)

                if (onDrag) {
                    onDrag(event, {
                        ...info,
                        point: {
                            x: point.x ? point.x.get() : 0,
                            y: point.y ? point.y.get() : 0,
                        },
                    })
                }
            }

            const onPanEnd = (
                event: MouseEvent | TouchEvent,
                { velocity }: PanInfo
            ) => {
                if (!dragPropagation && openGlobalLock) {
                    openGlobalLock()
                }

                if (dragMomentum) {
                    const startMomentum = (axis: "x" | "y") => {
                        if (!shouldDrag(axis, dragEnabled, currentDirection))
                            return

                        const transition = dragConstraints
                            ? getConstraints(axis, dragConstraints)
                            : {}

                        controls.start({
                            [axis]: 0,
                            transition: {
                                type: "inertia",
                                velocity: velocity[axis],
                                bounceStiffness: 200,
                                bounceDamping: 40,
                                timeConstant: 325,
                                restDelta: 1,
                                ...transition,
                            },
                        })
                    }

                    startMomentum("x")
                    startMomentum("y")
                }

                motionContext.dragging = false
                onDragEnd && onDragEnd(event)
            }

            return { onPanStart, onPan, onPanEnd }
        },
        [
            dragEnabled,
            motionContext.dragging,
            ...flattenConstraints(dragConstraints),
        ]
    )

    usePanGesture(handlers, ref)
}

function getCurrentDirection(offset: Point): DragDirection | null {
    const lockThreshold = 10
    let direction: DragDirection | null = null
    if (Math.abs(offset.y) > lockThreshold) {
        direction = "y"
    } else if (Math.abs(offset.x) > lockThreshold) {
        direction = "x"
    }
    return direction
}

const globalHorizontalLock = createLock("dragHorizontal")
const globalVerticalLock = createLock("dragVertical")
function getGlobalLock(drag: boolean | "x" | "y" | "lockDirection"): Lock {
    let lock: Lock = false
    if (drag === "y") {
        lock = globalVerticalLock()
    } else if (drag === "x") {
        lock = globalHorizontalLock()
    } else {
        const openHorizontal = globalHorizontalLock()
        const openVertical = globalVerticalLock()
        if (openHorizontal && openVertical) {
            lock = () => {
                openHorizontal()
                openVertical()
            }
        } else {
            // Release the locks because we don't use them
            if (openHorizontal) openHorizontal()
            if (openVertical) openVertical()
        }
    }
    return lock
}
