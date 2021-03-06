import Popper from 'popper.js'
import { Defaults, POPPER_INSTANCE_RELATED_PROPS } from './defaults'
import { Selectors } from './selectors'
import { isUsingTouch } from './bindGlobalEventListeners'
import { supportsTouch, isIE } from './browser'
import {
  createPopperElement,
  elementCanReceiveFocus,
  getChildren,
  computeArrowTransform,
  afterPopperPositionUpdates,
  getPopperPlacement,
  getOffsetDistanceInPx,
  getValue,
  closest,
  closestCallback,
  isCursorOutsideInteractiveBorder,
  applyTransitionDuration,
  setVisibilityState,
  updatePopperElement,
  evaluateProps,
  defer,
  toArray,
  focus,
  toggleTransitionEndListener,
  debounce,
  validateOptions,
  hasOwnProperty
} from './utils'

let idCounter = 1

/**
 * Creates and returns a Tippy object. We're using a closure pattern instead of
 * a class so that the exposed object API is clean without private members
 * prefixed with `_`.
 */
export default function createTippy(reference, collectionProps) {
  const props = evaluateProps(reference, collectionProps)

  // If the reference shouldn't have multiple tippys, return null early
  if (!props.multiple && reference._tippy) {
    return null
  }

  /* ======================= 🔒 Private members 🔒 ======================= */
  // The popper element's mutation observer
  let popperMutationObserver = null

  // The last trigger event object that caused the tippy to show
  let lastTriggerEvent = {}

  // The last mousemove event object created by the document mousemove event
  let lastMouseMoveEvent = null

  // Timeout created by the show delay
  let showTimeoutId = 0

  // Timeout created by the hide delay
  let hideTimeoutId = 0

  // Flag to determine if the tippy is preparing to show due to the show timeout
  let isPreparingToShow = false

  // The current `transitionend` callback reference
  let transitionEndListener = () => {}

  // Array of event listeners currently attached to the reference element
  let listeners = []

  // Flag to determine if the reference was recently programmatically focused
  let referenceJustProgrammaticallyFocused = false

  // Private onMouseMove handler reference, debounced or not
  let debouncedOnMouseMove =
    props.interactiveDebounce > 0
      ? debounce(onMouseMove, props.interactiveDebounce)
      : onMouseMove

  /* ======================= 🔑 Public members 🔑 ======================= */
  // id used for the `aria-describedby` attribute
  const id = idCounter++

  // Popper element reference
  const popper = createPopperElement(id, props)

  // Prevent a tippy with a delay from hiding if the cursor left then returned
  // before it started hiding
  popper.addEventListener('mouseenter', event => {
    if (
      tip.props.interactive &&
      tip.state.isVisible &&
      lastTriggerEvent.type === 'mouseenter'
    ) {
      prepareShow(event)
    }
  })
  popper.addEventListener('mouseleave', event => {
    if (
      tip.props.interactive &&
      lastTriggerEvent.type === 'mouseenter' &&
      tip.props.interactiveDebounce === 0 &&
      isCursorOutsideInteractiveBorder(
        getPopperPlacement(popper),
        popper.getBoundingClientRect(),
        event,
        tip.props
      )
    ) {
      prepareHide()
    }
  })

  // Popper element children: { arrow, backdrop, content, tooltip }
  const popperChildren = getChildren(popper)

  // The state of the tippy
  const state = {
    // If the tippy is currently enabled
    isEnabled: true,
    // show() invoked, not currently transitioning out
    isVisible: false,
    // If the tippy has been destroyed
    isDestroyed: false,
    // If the tippy is on the DOM (transitioning out or in)
    isMounted: false,
    // show() transition finished
    isShown: false
  }

  // Popper.js instance for the tippy is lazily created
  const popperInstance = null

  // 🌟 tippy instance
  const tip = {
    // properties
    id,
    reference,
    popper,
    popperChildren,
    popperInstance,
    props,
    state,
    // methods
    clearDelayTimeouts,
    set,
    setContent,
    show,
    hide,
    enable,
    disable,
    destroy
  }

  addTriggersToReference()

  reference.addEventListener('click', onReferenceClick)

  if (!props.lazy) {
    tip.popperInstance = createPopperInstance()
    tip.popperInstance.disableEventListeners()
  }

  if (props.showOnInit) {
    prepareShow()
  }

  // Ensure the reference element can receive focus (and is not a delegate)
  if (props.a11y && !props.target && !elementCanReceiveFocus(reference)) {
    reference.setAttribute('tabindex', '0')
  }

  // Install shortcuts
  reference._tippy = tip
  popper._tippy = tip

  return tip

  /* ======================= 🔒 Private methods 🔒 ======================= */
  /**
   * If the reference was clicked, it also receives focus
   */
  function onReferenceClick() {
    defer(() => {
      referenceJustProgrammaticallyFocused = false
    })
  }

  /**
   * Ensure the popper's position stays correct if its dimensions change. Use
   * update() over .scheduleUpdate() so there is no 1 frame flash due to
   * async update
   */
  function addMutationObserver() {
    popperMutationObserver = new MutationObserver(() => {
      tip.popperInstance.update()
    })
    popperMutationObserver.observe(popper, {
      childList: true,
      subtree: true,
      characterData: true
    })
  }

  /**
   * Positions the virtual reference near the mouse cursor
   */
  function positionVirtualReferenceNearCursor(event) {
    const { clientX, clientY } = (lastMouseMoveEvent = event)

    if (!tip.popperInstance) {
      return
    }

    // Ensure virtual reference is padded by 5px to prevent tooltip from
    // overflowing. Maybe Popper.js issue?
    const placement = getPopperPlacement(tip.popper)
    const padding = tip.popperChildren.arrow ? 20 : 5
    const isVerticalPlacement = placement === 'top' || placement === 'bottom'
    const isHorizontalPlacement = placement === 'left' || placement === 'right'

    // Top / left boundary
    let x = isVerticalPlacement ? Math.max(padding, clientX) : clientX
    let y = isHorizontalPlacement ? Math.max(padding, clientY) : clientY

    // Bottom / right boundary
    if (isVerticalPlacement && x > padding) {
      x = Math.min(clientX, window.innerWidth - padding)
    }
    if (isHorizontalPlacement && y > padding) {
      y = Math.min(clientY, window.innerHeight - padding)
    }

    const rect = tip.reference.getBoundingClientRect()
    const { followCursor } = tip.props
    const isHorizontal = followCursor === 'horizontal'
    const isVertical = followCursor === 'vertical'

    tip.popperInstance.reference = {
      getBoundingClientRect: () => ({
        width: 0,
        height: 0,
        top: isHorizontal ? rect.top : y,
        bottom: isHorizontal ? rect.bottom : y,
        left: isVertical ? rect.left : x,
        right: isVertical ? rect.right : x
      }),
      clientWidth: 0,
      clientHeight: 0
    }

    tip.popperInstance.scheduleUpdate()
  }

  /**
   * Creates the tippy instance for a delegate when it's been triggered
   */
  function createDelegateChildTippy(event) {
    const targetEl = closest(event.target, tip.props.target)
    if (targetEl && !targetEl._tippy) {
      createTippy(targetEl, {
        ...tip.props,
        target: '',
        showOnInit: true
      })
      prepareShow(event)
    }
  }

  /**
   * Setup before show() is invoked (delays, etc.)
   */
  function prepareShow(event) {
    clearDelayTimeouts()

    if (tip.state.isVisible) {
      return
    }

    // Is a delegate, create an instance for the child target
    if (tip.props.target) {
      return createDelegateChildTippy(event)
    }

    isPreparingToShow = true

    if (tip.props.wait) {
      return tip.props.wait(tip, event)
    }

    // If the tooltip has a delay, we need to be listening to the mousemove as
    // soon as the trigger event is fired, so that it's in the correct position
    // upon mount
    if (hasFollowCursorBehavior()) {
      document.addEventListener('mousemove', positionVirtualReferenceNearCursor)
    }

    const delay = getValue(tip.props.delay, 0, Defaults.delay)

    if (delay) {
      showTimeoutId = setTimeout(() => {
        show()
      }, delay)
    } else {
      show()
    }
  }

  /**
   * Setup before hide() is invoked (delays, etc.)
   */
  function prepareHide() {
    clearDelayTimeouts()

    if (!tip.state.isVisible) {
      return removeFollowCursorListener()
    }

    isPreparingToShow = false

    const delay = getValue(tip.props.delay, 1, Defaults.delay)

    if (delay) {
      hideTimeoutId = setTimeout(() => {
        if (tip.state.isVisible) {
          hide()
        }
      }, delay)
    } else {
      hide()
    }
  }

  /**
   * Removes the follow cursor listener
   */
  function removeFollowCursorListener() {
    document.removeEventListener(
      'mousemove',
      positionVirtualReferenceNearCursor
    )
    lastMouseMoveEvent = null
  }

  /**
   * Cleans up old listeners
   */
  function cleanupOldMouseListeners() {
    document.body.removeEventListener('mouseleave', prepareHide)
    document.removeEventListener('mousemove', debouncedOnMouseMove)
  }

  /**
   * Event listener invoked upon trigger
   */
  function onTrigger(event) {
    if (!tip.state.isEnabled || isEventListenerStopped(event)) {
      return
    }

    if (!tip.state.isVisible) {
      lastTriggerEvent = event
    }

    // Toggle show/hide when clicking click-triggered tooltips
    if (
      event.type === 'click' &&
      tip.props.hideOnClick !== false &&
      tip.state.isVisible
    ) {
      prepareHide()
    } else {
      prepareShow(event)
    }
  }

  /**
   * Event listener used for interactive tooltips to detect when they should
   * hide
   */
  function onMouseMove(event) {
    const referenceTheCursorIsOver = closestCallback(
      event.target,
      el => el._tippy
    )

    const isCursorOverPopper =
      closest(event.target, Selectors.POPPER) === tip.popper
    const isCursorOverReference = referenceTheCursorIsOver === tip.reference

    if (isCursorOverPopper || isCursorOverReference) {
      return
    }

    if (
      isCursorOutsideInteractiveBorder(
        getPopperPlacement(tip.popper),
        tip.popper.getBoundingClientRect(),
        event,
        tip.props
      )
    ) {
      cleanupOldMouseListeners()
      prepareHide()
    }
  }

  /**
   * Event listener invoked upon mouseleave
   */
  function onMouseLeave(event) {
    if (isEventListenerStopped(event)) {
      return
    }

    if (tip.props.interactive) {
      document.body.addEventListener('mouseleave', prepareHide)
      document.addEventListener('mousemove', debouncedOnMouseMove)
      return
    }

    prepareHide()
  }

  /**
   * Event listener invoked upon blur
   */
  function onBlur(event) {
    if (event.target !== tip.reference) {
      return
    }

    if (tip.props.interactive) {
      if (!event.relatedTarget) {
        return
      }
      if (closest(event.relatedTarget, Selectors.POPPER)) {
        return
      }
    }

    prepareHide()
  }

  /**
   * Event listener invoked when a child target is triggered
   */
  function onDelegateShow(event) {
    if (closest(event.target, tip.props.target)) {
      prepareShow(event)
    }
  }

  /**
   * Event listener invoked when a child target should hide
   */
  function onDelegateHide(event) {
    if (closest(event.target, tip.props.target)) {
      prepareHide()
    }
  }

  /**
   * Determines if an event listener should stop further execution due to the
   * `touchHold` option
   */
  function isEventListenerStopped(event) {
    const isTouchEvent = event.type.indexOf('touch') > -1
    const caseA =
      supportsTouch && isUsingTouch && tip.props.touchHold && !isTouchEvent
    const caseB = isUsingTouch && !tip.props.touchHold && isTouchEvent
    return caseA || caseB
  }

  /**
   * Creates the popper instance for the tip
   */
  function createPopperInstance() {
    const { tooltip } = tip.popperChildren
    const { popperOptions } = tip.props

    const arrowSelector =
      Selectors[tip.props.arrowType === 'round' ? 'ROUND_ARROW' : 'ARROW']
    const arrow = tooltip.querySelector(arrowSelector)

    const config = {
      placement: tip.props.placement,
      ...(popperOptions || {}),
      modifiers: {
        ...(popperOptions ? popperOptions.modifiers : {}),
        arrow: {
          element: arrowSelector,
          ...(popperOptions && popperOptions.modifiers
            ? popperOptions.modifiers.arrow
            : {})
        },
        flip: {
          enabled: tip.props.flip,
          padding: tip.props.distance + 5 /* 5px from viewport boundary */,
          behavior: tip.props.flipBehavior,
          ...(popperOptions && popperOptions.modifiers
            ? popperOptions.modifiers.flip
            : {})
        },
        offset: {
          offset: tip.props.offset,
          ...(popperOptions && popperOptions.modifiers
            ? popperOptions.modifiers.offset
            : {})
        }
      },
      onCreate() {
        tooltip.style[getPopperPlacement(tip.popper)] = getOffsetDistanceInPx(
          tip.props.distance,
          Defaults.distance
        )

        if (arrow && tip.props.arrowTransform) {
          computeArrowTransform(arrow, tip.props.arrowTransform)
        }
      },
      onUpdate() {
        const styles = tooltip.style
        styles.top = ''
        styles.bottom = ''
        styles.left = ''
        styles.right = ''
        styles[getPopperPlacement(tip.popper)] = getOffsetDistanceInPx(
          tip.props.distance,
          Defaults.distance
        )

        if (arrow && tip.props.arrowTransform) {
          computeArrowTransform(arrow, tip.props.arrowTransform)
        }
      }
    }

    if (!popperMutationObserver) {
      addMutationObserver()
    }

    return new Popper(tip.reference, tip.popper, config)
  }

  /**
   * Mounts the tooltip to the DOM, callback to show tooltip is run **after**
   * popper's position has updated
   */
  function mount(callback) {
    if (!tip.popperInstance) {
      tip.popperInstance = createPopperInstance()
      if (!tip.props.livePlacement || hasFollowCursorBehavior()) {
        tip.popperInstance.disableEventListeners()
      }
    } else {
      if (!hasFollowCursorBehavior()) {
        tip.popperInstance.scheduleUpdate()
        if (tip.props.livePlacement) {
          tip.popperInstance.enableEventListeners()
        }
      }
    }

    // If the instance previously had followCursor behavior, it will be
    // positioned incorrectly if triggered by `focus` afterwards.
    // Update the reference back to the real DOM element
    tip.popperInstance.reference = tip.reference
    const { arrow } = tip.popperChildren

    if (hasFollowCursorBehavior()) {
      if (arrow) {
        arrow.style.margin = '0'
      }
      const delay = getValue(tip.props.delay, 0, Defaults.delay)
      if (lastTriggerEvent.type) {
        positionVirtualReferenceNearCursor(
          delay && lastMouseMoveEvent ? lastMouseMoveEvent : lastTriggerEvent
        )
      }
    } else if (arrow) {
      arrow.style.margin = ''
    }

    afterPopperPositionUpdates(tip.popperInstance, callback)

    if (!tip.props.appendTo.contains(tip.popper)) {
      tip.props.appendTo.appendChild(tip.popper)
      tip.props.onMount(tip)
      tip.state.isMounted = true
    }
  }

  /**
   * Determines if the instance is in `followCursor` mode
   */
  function hasFollowCursorBehavior() {
    return (
      tip.props.followCursor &&
      !isUsingTouch &&
      lastTriggerEvent.type !== 'focus'
    )
  }

  /**
   * Updates the tooltip's position on each animation frame + timeout
   */
  function makeSticky() {
    applyTransitionDuration([tip.popper], isIE ? 0 : tip.props.updateDuration)

    const updatePosition = () => {
      if (tip.popperInstance) {
        tip.popperInstance.scheduleUpdate()
      }

      if (tip.state.isMounted) {
        requestAnimationFrame(updatePosition)
      } else {
        applyTransitionDuration([tip.popper], 0)
      }
    }

    updatePosition()
  }

  /**
   * Invokes a callback once the tooltip has fully transitioned out
   */
  function onTransitionedOut(duration, callback) {
    onTransitionEnd(duration, () => {
      if (!tip.state.isVisible && tip.props.appendTo.contains(tip.popper)) {
        callback()
      }
    })
  }

  /**
   * Invokes a callback once the tooltip has fully transitioned in
   */
  function onTransitionedIn(duration, callback) {
    onTransitionEnd(duration, callback)
  }

  /**
   * Invokes a callback once the tooltip's CSS transition ends
   */
  function onTransitionEnd(duration, callback) {
    // Make callback synchronous if duration is 0
    if (duration === 0) {
      return callback()
    }

    const { tooltip } = tip.popperChildren

    const listener = e => {
      if (e.target === tooltip) {
        toggleTransitionEndListener(tooltip, 'remove', listener)
        callback()
      }
    }

    toggleTransitionEndListener(tooltip, 'remove', transitionEndListener)
    toggleTransitionEndListener(tooltip, 'add', listener)

    transitionEndListener = listener
  }

  /**
   * Adds an event listener to the reference
   */
  function on(eventType, handler, acc) {
    tip.reference.addEventListener(eventType, handler)
    acc.push({ eventType, handler })
  }

  /**
   * Adds event listeners to the reference based on the `trigger` prop
   */
  function addTriggersToReference() {
    listeners = tip.props.trigger
      .trim()
      .split(' ')
      .reduce((acc, eventType) => {
        if (eventType === 'manual') {
          return acc
        }

        if (!tip.props.target) {
          on(eventType, onTrigger, acc)

          if (tip.props.touchHold) {
            on('touchstart', onTrigger, acc)
            on('touchend', onMouseLeave, acc)
          }

          switch (eventType) {
            case 'mouseenter':
              on('mouseleave', onMouseLeave, acc)
              break
            case 'focus':
              on(isIE ? 'focusout' : 'blur', onBlur, acc)
              break
          }
        } else {
          switch (eventType) {
            case 'mouseenter':
              on('mouseover', onDelegateShow, acc)
              on('mouseout', onDelegateHide, acc)
              break
            case 'focus':
              on('focusin', onDelegateShow, acc)
              on('focusout', onDelegateHide, acc)
              break
            case 'click':
              on(eventType, onDelegateShow, acc)
              break
          }
        }

        return acc
      }, [])
  }

  /**
   * Removes event listeners from the reference
   */
  function removeTriggersFromReference() {
    listeners.forEach(({ eventType, handler }) => {
      tip.reference.removeEventListener(eventType, handler)
    })
  }

  /* ======================= 🔑 Public methods 🔑 ======================= */
  /**
   * Enables the instance to allow it to show or hide
   */
  function enable() {
    tip.state.isEnabled = true
  }

  /**
   * Disables the instance to disallow it to show or hide
   */
  function disable() {
    tip.state.isEnabled = false
  }

  /**
   * Clears pending timeouts related to the `delay` prop if any
   */
  function clearDelayTimeouts() {
    clearTimeout(showTimeoutId)
    clearTimeout(hideTimeoutId)
  }

  /**
   * Sets new props for the instance and redraws the tooltip
   */
  function set(options = {}) {
    validateOptions(options, Defaults)

    const prevProps = tip.props
    const nextProps = evaluateProps(tip.reference, {
      ...tip.props,
      ...options,
      performance: true
    })
    nextProps.performance = hasOwnProperty(options, 'performance')
      ? options.performance
      : prevProps.performance
    tip.props = nextProps

    if (
      hasOwnProperty(options, 'trigger') ||
      hasOwnProperty(options, 'touchHold')
    ) {
      removeTriggersFromReference()
      addTriggersToReference()
    }

    if (hasOwnProperty(options, 'interactiveDebounce')) {
      cleanupOldMouseListeners()
      debouncedOnMouseMove = debounce(onMouseMove, options.interactiveDebounce)
    }

    updatePopperElement(tip.popper, prevProps, nextProps)
    tip.popperChildren = getChildren(tip.popper)

    if (
      tip.popperInstance &&
      POPPER_INSTANCE_RELATED_PROPS.some(prop => hasOwnProperty(options, prop))
    ) {
      tip.popperInstance.destroy()
      tip.popperInstance = createPopperInstance()
      if (!tip.state.isVisible) {
        tip.popperInstance.disableEventListeners()
      }
      if (tip.props.followCursor && lastMouseMoveEvent) {
        positionVirtualReferenceNearCursor(lastMouseMoveEvent)
      }
    }
  }

  /**
   * Shortcut for .set({ content: newContent })
   */
  function setContent(content) {
    set({ content })
  }

  /**
   * Shows the tooltip
   */
  function show(
    duration = getValue(tip.props.duration, 0, Defaults.duration[0])
  ) {
    if (
      tip.state.isDestroyed ||
      !tip.state.isEnabled ||
      (isUsingTouch && !tip.props.touch)
    ) {
      return
    }

    // Destroy tooltip if the reference element is no longer on the DOM
    if (
      !tip.reference.isVirtual &&
      !document.documentElement.contains(tip.reference)
    ) {
      return destroy()
    }

    // Do not show tooltip if the reference element has a `disabled` attribute
    if (tip.reference.hasAttribute('disabled')) {
      return
    }

    // If the reference was just programmatically focused for accessibility
    // reasons
    if (referenceJustProgrammaticallyFocused) {
      referenceJustProgrammaticallyFocused = false
      return
    }

    if (tip.props.onShow(tip) === false) {
      return
    }

    tip.popper.style.visibility = 'visible'
    tip.state.isVisible = true

    // Prevent a transition if the popper is at the opposite placement
    applyTransitionDuration(
      [tip.popper, tip.popperChildren.tooltip, tip.popperChildren.backdrop],
      0
    )

    mount(() => {
      if (!tip.state.isVisible) {
        return
      }

      // Arrow will sometimes not be positioned correctly. Force another update
      if (!hasFollowCursorBehavior()) {
        tip.popperInstance.update()
      }

      applyTransitionDuration(
        [
          tip.popperChildren.tooltip,
          tip.popperChildren.backdrop,
          tip.popperChildren.content
        ],
        duration
      )
      if (tip.popperChildren.backdrop) {
        tip.popperChildren.content.style.transitionDelay =
          Math.round(duration / 6) + 'ms'
      }

      if (tip.props.interactive) {
        tip.reference.classList.add('tippy-active')
      }

      if (tip.props.sticky) {
        makeSticky()
      }

      setVisibilityState(
        [
          tip.popperChildren.tooltip,
          tip.popperChildren.backdrop,
          tip.popperChildren.content
        ],
        'visible'
      )

      onTransitionedIn(duration, () => {
        if (tip.props.updateDuration === 0) {
          tip.popperChildren.tooltip.classList.add('tippy-notransition')
        }

        if (
          tip.props.interactive &&
          ['focus', 'click'].indexOf(lastTriggerEvent.type) > -1
        ) {
          focus(tip.popper)
        }

        tip.reference.setAttribute('aria-describedby', tip.popper.id)

        tip.props.onShown(tip)
        tip.state.isShown = true
      })
    })
  }

  /**
   * Hides the tooltip
   */
  function hide(
    duration = getValue(tip.props.duration, 1, Defaults.duration[1])
  ) {
    if (tip.state.isDestroyed || !tip.state.isEnabled) {
      return
    }

    if (tip.props.onHide(tip) === false) {
      return
    }

    if (tip.props.updateDuration === 0) {
      tip.popperChildren.tooltip.classList.remove('tippy-notransition')
    }

    if (tip.props.interactive) {
      tip.reference.classList.remove('tippy-active')
    }

    tip.popper.style.visibility = 'hidden'
    tip.state.isVisible = false
    tip.state.isShown = false

    applyTransitionDuration(
      [
        tip.popperChildren.tooltip,
        tip.popperChildren.backdrop,
        tip.popperChildren.content
      ],
      duration
    )

    setVisibilityState(
      [
        tip.popperChildren.tooltip,
        tip.popperChildren.backdrop,
        tip.popperChildren.content
      ],
      'hidden'
    )

    if (
      tip.props.interactive &&
      !referenceJustProgrammaticallyFocused &&
      ['focus', 'click'].indexOf(lastTriggerEvent.type) > -1
    ) {
      if (lastTriggerEvent.type === 'focus') {
        referenceJustProgrammaticallyFocused = true
      }
      focus(tip.reference)
    }

    onTransitionedOut(duration, () => {
      if (!isPreparingToShow) {
        removeFollowCursorListener()
      }

      tip.reference.removeAttribute('aria-describedby')

      tip.popperInstance.disableEventListeners()

      tip.props.appendTo.removeChild(tip.popper)
      tip.state.isMounted = false

      tip.props.onHidden(tip)
    })
  }

  /**
   * Destroys the tooltip
   */
  function destroy(destroyTargetInstances) {
    if (tip.state.isDestroyed) {
      return
    }

    // If the popper is currently mounted to the DOM, we want to ensure it gets
    // hidden and unmounted instantly upon destruction
    if (tip.state.isMounted) {
      hide(0)
    }

    removeTriggersFromReference()

    tip.reference.removeEventListener('click', onReferenceClick)

    delete tip.reference._tippy

    if (tip.props.target && destroyTargetInstances) {
      toArray(tip.reference.querySelectorAll(tip.props.target)).forEach(
        child => child._tippy && child._tippy.destroy()
      )
    }

    if (tip.popperInstance) {
      tip.popperInstance.destroy()
    }

    if (popperMutationObserver) {
      popperMutationObserver.disconnect()
    }

    tip.state.isDestroyed = true
  }
}
