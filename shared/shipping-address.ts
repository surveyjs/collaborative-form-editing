/**
 * Docs sample composite (`shippingaddress`) used to exercise nested content
 * under CollaborationPlugin. Injected survey-core types — this file must not
 * import survey-core, or each client would get a second Serializer singleton.
 *
 * https://surveyjs.io/form-library/examples/composite-questions/documentation
 */

export const SHIPPING_ADDRESS_TYPE = "shippingaddress";

interface ISerializerLike {
    getProperty(className: string, name: string): { visible: boolean; defaultValue?: unknown } | null | undefined;
    addProperty(className: string, json: any): any;
}

interface IComponentCollectionLike {
    Instance: {
        getCustomQuestionByName?(name: string): unknown;
        add(config: any): void;
    };
}

interface INestedQuestion {
    value: unknown;
}

interface ICompositeQuestion {
    contentPanel?: {
        getQuestionByName(name: string): INestedQuestion | undefined;
    };
}

export function registerShippingAddress(deps: {
    ComponentCollection: IComponentCollectionLike;
    Serializer: ISerializerLike;
}): void {
    const { ComponentCollection, Serializer } = deps;
    if (ComponentCollection.Instance.getCustomQuestionByName?.(SHIPPING_ADDRESS_TYPE)) return;

    ComponentCollection.Instance.add({
        name: SHIPPING_ADDRESS_TYPE,
        title: "Shipping Address",
        defaultQuestionTitle: "Shipping Address",
        elementsJSON: [{
            type: "comment",
            name: "businessAddress",
            title: "Business Address",
            isRequired: true
        }, {
            type: "boolean",
            name: "shippingSameAsBusiness",
            title: "Shipping address same as business address",
            defaultValue: true
        }, {
            type: "comment",
            name: "shippingAddress",
            title: "Shipping Address",
            enableIf: "{composite.shippingSameAsBusiness} <> true",
            isRequired: true
        }],
        onInit() {
            const hide = (name: string, defaults?: { default?: unknown }): void => {
                const existing = Serializer.getProperty(SHIPPING_ADDRESS_TYPE, name);
                if (existing) {
                    existing.visible = false;
                    if (defaults && "default" in defaults) existing.defaultValue = defaults.default;
                    return;
                }
                Serializer.addProperty(SHIPPING_ADDRESS_TYPE, {
                    name,
                    visible: false,
                    ...(defaults?.default !== undefined ? { default: defaults.default } : {})
                });
            };
            hide("titleLocation", { default: "hidden" });
            hide("title");
            hide("description");
        },
        onValueChanged(question: ICompositeQuestion, propertyName: string) {
            const panel = question.contentPanel;
            if (!panel) return;
            const businessAddress = panel.getQuestionByName("businessAddress");
            const shippingAddress = panel.getQuestionByName("shippingAddress");
            const shippingSameAsBusiness = panel.getQuestionByName("shippingSameAsBusiness");
            if (!businessAddress || !shippingAddress || !shippingSameAsBusiness) return;

            if (propertyName === "businessAddress") {
                if (shippingSameAsBusiness.value == true) {
                    shippingAddress.value = businessAddress.value;
                }
            }
            if (propertyName === "shippingSameAsBusiness") {
                shippingAddress.value = shippingSameAsBusiness.value == true ? businessAddress.value : "";
            }
        }
    });
}

export function ensureShippingAddressInToolbox(creator: {
    toolbox?: {
        getItemByName?(name: string): unknown;
        addItem(item: object): unknown;
    };
}): void {
    const toolbox = creator.toolbox;
    if (!toolbox) return;
    try {
        if (toolbox.getItemByName?.(SHIPPING_ADDRESS_TYPE)) return;
        toolbox.addItem({
            name: SHIPPING_ADDRESS_TYPE,
            title: "Shipping Address",
            iconName: "icon-composite",
            category: "general",
            json: { type: SHIPPING_ADDRESS_TYPE }
        });
    } catch {
        // Toolbox shape differs across versions; ComponentCollection registration is enough.
    }
}
